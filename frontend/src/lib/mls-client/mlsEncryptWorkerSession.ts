import MlsEncryptWorker from '../workers/mlsEncrypt.worker?worker';
import { encryptMlsStateOnMainThread } from './mlsWasmLoader';

const ENCRYPT_WORKER_TIMEOUT_MS = 60_000;

type EncryptWorkerOk = { type: 'encrypt:ok'; payload: { encrypted: ArrayBuffer } };
type EncryptWorkerErr = { type: 'encrypt:error'; error: string };
type EncryptWorkerResponse = EncryptWorkerOk | EncryptWorkerErr;

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
  pin: string,
  workerFactory: () => Worker
): Promise<Uint8Array> {
  const worker = getSharedWorker(workerFactory);
  const plainBuffer = plain.slice().buffer;

  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MLS encrypt worker timeout (${ENCRYPT_WORKER_TIMEOUT_MS}ms)`));
    }, ENCRYPT_WORKER_TIMEOUT_MS);

    const onMessage = (event: MessageEvent<EncryptWorkerResponse>) => {
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
    worker.postMessage({ type: 'encrypt', payload: { plain: plainBuffer, pin } }, [plainBuffer]);
  });
}

/**
 * Encrypts a plain MLS CBOR snapshot off the main thread (Argon2 + ChaCha20).
 * Falls back to main-thread WASM when workers are disabled or unavailable.
 */
export async function encryptMlsStateOffThread(
  plain: Uint8Array,
  pin: string,
  options?: {
    enabled?: boolean;
    workerFactory?: () => Worker;
  }
): Promise<Uint8Array> {
  const enabled = options?.enabled ?? true;
  const canUseWorker =
    enabled && (typeof Worker !== 'undefined' || options?.workerFactory !== undefined);
  if (!canUseWorker) {
    return encryptMlsStateOnMainThread(plain, pin);
  }

  const workerFactory = options?.workerFactory ?? (() => new MlsEncryptWorker());
  const job = jobChain.then(() => runEncryptOnWorker(plain, pin, workerFactory));
  jobChain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}
