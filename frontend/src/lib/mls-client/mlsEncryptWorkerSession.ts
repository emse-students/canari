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

/** Terminates the shared encrypt worker (tests / teardown). */
export function disposeMlsEncryptWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
  jobChain = Promise.resolve();
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

    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
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
  const job = jobChain.then(() => runEncryptOnWorker(plain, deviceKeyB64, workerFactory));
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
