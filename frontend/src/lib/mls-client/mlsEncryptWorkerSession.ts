import MlsEncryptWorker from '../workers/mlsEncrypt.worker?worker';
import { encryptMlsStateOnMainThread } from './mlsWasmLoader';
import type { MlsEncryptRequest, MlsEncryptResponse } from './mlsWorkerProtocol';

const ENCRYPT_WORKER_TIMEOUT_MS = 60_000;

let sharedWorker: Worker | null = null;
/** Serialises encrypt jobs on a single worker (WASM init is not re-entrant). */
let jobChain: Promise<void> = Promise.resolve();

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
 * Encrypts a plain MLS CBOR snapshot off the main thread (Argon2 + ChaCha20).
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
