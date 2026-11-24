import MlsEncryptWorker from '../workers/mlsEncrypt.worker?worker';
import { encryptMlsStateOnMainThread } from './mlsWasmLoader';
import { sealMlsStateBlobV2 } from './mlsStateSeal';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import type { MlsEncryptRequest, MlsEncryptResponse } from './mlsWorkerProtocol';

const ENCRYPT_WORKER_TIMEOUT_MS = 60_000;

let sharedWorker: Worker | null = null;
/** Serialises encrypt jobs on a single worker (WASM init is not re-entrant). */
let jobChain: Promise<void> = Promise.resolve();

/** The at-rest format last reported, so a session names its checkpoint format once, not per save. */
let loggedSealFormat: string | null = null;

/**
 * Names the web checkpoint's at-rest format the first time it is used, and again only if it ever
 * changes. It is the line a device reading looks for to know which format a build WROTE - the
 * reader's own line (`loadAndInitWasm`) only says what the previous session left.
 */
function logSealFormatOnce(format: string): void {
  if (loggedSealFormat === format) return;
  loggedSealFormat = format;
  console.log(`[MLS] web checkpoint seal format: ${format}`);
}

/**
 * The round trips waiting on the shared worker, each with its rejection. A terminated worker
 * dispatches no event at all, so without this a job in flight when the worker is disposed would wait
 * for its timeout - and a checkpoint holding the lead (`leadHolds.ts`) would hold it as long.
 */
const pendingJobs = new Set<(reason: Error) => void>();

/**
 * How many times the worker was disposed: a job queued on {@link jobChain} before a disposal is
 * rejected when its turn comes, never run on the worker created after it.
 */
let disposals = 0;

/**
 * The worker was terminated under a round trip, or before a job queued behind one started: the job
 * ends, it never waits for an answer. Module-private: no caller branches on it - a checkpoint fails
 * with it like with any seal failure - it exists so the cause is named in that failure's log.
 */
class MlsEncryptWorkerTerminatedError extends Error {
  constructor() {
    super('MLS encrypt worker terminated before it answered');
    this.name = 'MlsEncryptWorkerTerminatedError';
  }
}

/**
 * Terminates the shared encrypt worker (tests / teardown). Every round trip still waiting on it is
 * REJECTED here ({@link MlsEncryptWorkerTerminatedError}): termination is this document's own act,
 * so it is the proof that no answer will come.
 */
export function disposeMlsEncryptWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
  disposals += 1;
  jobChain = Promise.resolve();
  const waiting = [...pendingJobs];
  pendingJobs.clear();
  for (const reject of waiting) reject(new MlsEncryptWorkerTerminatedError());
}

function getSharedWorker(workerFactory: () => Worker): Worker {
  if (!sharedWorker) {
    sharedWorker = workerFactory();
  }
  return sharedWorker;
}

function runEncryptOnWorker(
  plain: Uint8Array,
  deviceKeyB64: string,
  workerFactory: () => Worker
): Promise<Uint8Array> {
  const worker = getSharedWorker(workerFactory);
  const plainBuffer = plain.slice().buffer;

  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MLS encrypt worker timeout (${ENCRYPT_WORKER_TIMEOUT_MS}ms)`));
    }, ENCRYPT_WORKER_TIMEOUT_MS);

    const onMessage = (event: MessageEvent<MlsEncryptResponse>) => {
      const msg = event.data;
      if (!msg) return;
      cleanup();
      if (msg.type === 'encrypt:ok') {
        resolve(new Uint8Array(msg.payload.encrypted));
      } else {
        reject(new Error(msg.error));
      }
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message || 'MLS encrypt worker error'));
    };

    // A reply the structured clone could not deserialise never reaches `message`: it ends here.
    const onMessageError = () => {
      cleanup();
      reject(new Error('MLS encrypt worker reply could not be deserialised (messageerror)'));
    };

    const onTerminated = (reason: Error) => {
      cleanup();
      reject(reason);
    };

    const cleanup = () => {
      clearTimeout(timer);
      pendingJobs.delete(onTerminated);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };

    pendingJobs.add(onTerminated);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    // Typed through the shared contract: the worker reads `payload.deviceKeyB64`, and a rename
    // on either side must not be able to reach production as a silent `undefined`.
    const request: MlsEncryptRequest = {
      type: 'encrypt',
      payload: { plain: plainBuffer, deviceKeyB64 },
    };
    worker.postMessage(request, [plainBuffer]);
  });
}

/**
 * Encrypts a plain MLS CBOR snapshot off the main thread (WASM ChaCha20-Poly1305 under the device
 * key - there has been no Argon2 on this path since v0.11.0).
 * Falls back to main-thread WASM when workers are disabled or unavailable.
 */
export async function encryptMlsStateOffThread(
  plain: Uint8Array,
  deviceKeyB64: string,
  options?: {
    enabled?: boolean;
    workerFactory?: () => Worker;
  }
): Promise<Uint8Array> {
  const enabled = options?.enabled ?? true;
  const canUseWorker =
    enabled && (typeof Worker !== 'undefined' || options?.workerFactory !== undefined);
  if (!canUseWorker) {
    return encryptMlsStateOnMainThread(plain, deviceKeyB64);
  }

  const workerFactory = options?.workerFactory ?? (() => new MlsEncryptWorker());
  const queuedAt = disposals;
  const job = jobChain.then(() => {
    // Disposed while this job waited for its turn: the session that queued it ended with the worker.
    if (disposals !== queuedAt) throw new MlsEncryptWorkerTerminatedError();
    return runEncryptOnWorker(plain, deviceKeyB64, workerFactory);
  });
  jobChain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

/**
 * The ONE decision of which at-rest format a web checkpoint is sealed in.
 *
 * `v2` is the framed WebCrypto AES-GCM blob (`mlsStateSeal.ts`), sealed on the calling thread
 * because WebCrypto already does its cipher work off the JavaScript thread; otherwise the legacy
 * WASM ChaCha20-Poly1305 blob, through the encrypt worker when `useEncryptWorker`.
 *
 * **V2 IS NEVER WRITTEN INSIDE TAURI.** No native path reaches this function today (native state is
 * sealed in Rust and written by the Tauri command), so the guard below is not a branch anything
 * takes - it is the invariant made executable, so a future caller that does reach it fails the
 * checkpoint loudly instead of writing a format no native writer produces.
 */
export async function sealWebMlsState(
  plain: Uint8Array,
  deviceKeyB64: string,
  options: { v2: boolean; useEncryptWorker: boolean }
): Promise<Uint8Array> {
  logSealFormatOnce(options.v2 ? 'framed v2 (WebCrypto AES-GCM)' : 'legacy (WASM ChaCha20)');
  if (options.v2) {
    if (isTauriRuntime()) {
      throw new Error(
        '[MLS] the v2 WebCrypto state seal is web-only and was reached inside Tauri - refusing to write it'
      );
    }
    return sealMlsStateBlobV2(plain, deviceKeyB64);
  }
  return encryptMlsStateOffThread(plain, deviceKeyB64, { enabled: options.useEncryptWorker });
}
