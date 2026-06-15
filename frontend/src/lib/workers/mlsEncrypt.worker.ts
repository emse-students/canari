import { encryptMlsStateOnMainThread, loadMlsWasmModule } from '$lib/mls-client/mlsWasmLoader';

/**
 * Some generated WASM glue paths still reference `window` unconditionally.
 * In worker context we alias it to globalThis to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

interface EncryptRequest {
  type: 'encrypt';
  payload: {
    plain: ArrayBuffer;
    pin: string;
  };
}

interface EncryptOk {
  type: 'encrypt:ok';
  payload: { encrypted: ArrayBuffer };
}

interface EncryptErr {
  type: 'encrypt:error';
  error: string;
}

let wasmReady: Promise<void> | null = null;

/** Initialises the WASM module once per worker lifetime. */
function ensureWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = loadMlsWasmModule().then(() => undefined);
  }
  return wasmReady;
}

type EncryptWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<EncryptRequest>) => void) | null;
  postMessage: (message: EncryptOk | EncryptErr, transfer?: Transferable[]) => void;
};

const workerScope = self as EncryptWorkerScope;

workerScope.onmessage = async (event: MessageEvent<EncryptRequest>) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'encrypt') return;

  const { plain, pin } = msg.payload;
  try {
    await ensureWasmReady();
    const encrypted = await encryptMlsStateOnMainThread(new Uint8Array(plain), pin);
    const response: EncryptOk = {
      type: 'encrypt:ok',
      payload: { encrypted: encrypted.slice().buffer },
    };
    workerScope.postMessage(response, [response.payload.encrypted]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({ type: 'encrypt:error', error: message });
  }
};
