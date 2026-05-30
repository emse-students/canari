import { loadAndInitWasm } from '$lib/mls-client/mlsWasmLoader';

/**
 * Some generated WASM glue paths still reference `window` unconditionally.
 * In worker context we alias it to globalThis to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

/**
 * Request payload for key package generation in the dedicated worker.
 * The worker owns a temporary WASM client instance so heavy crypto does not block UI rendering.
 */
interface GenerateKeyPackageRequest {
  type: 'generateKeyPackage';
  payload: {
    userId: string;
    deviceId: string;
    pin: string;
    needed: number;
    state?: ArrayBuffer;
  };
}

/**
 * Successful worker response with generated fallback key package, one-time packages, and updated state.
 */
interface GenerateKeyPackageOk {
  type: 'generateKeyPackage:ok';
  payload: {
    fallback: ArrayBuffer;
    poolPackages: ArrayBuffer[];
    state: ArrayBuffer;
  };
}

/** Failed worker response with a human-readable error message. */
interface GenerateKeyPackageErr {
  type: 'generateKeyPackage:error';
  error: string;
}

/** Returns a detached ArrayBuffer copy suitable for transferable postMessage payloads. */
function asTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

type KeyPackageWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<GenerateKeyPackageRequest>) => void) | null;
  postMessage: (
    message: GenerateKeyPackageOk | GenerateKeyPackageErr,
    transfer?: Transferable[]
  ) => void;
};

const workerScope = self as KeyPackageWorkerScope;

/** Worker-side message handler for MLS heavy startup operations. */
workerScope.onmessage = async (event: MessageEvent<GenerateKeyPackageRequest>) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'generateKeyPackage') return;

  const { userId, deviceId, pin, needed, state } = msg.payload;
  try {
    console.log(`[MLS Worker] generateKeyPackage start needed=${needed}`);
    const initialState = state ? new Uint8Array(state) : undefined;
    const client = await loadAndInitWasm(userId, deviceId, initialState, pin);

    const fallback = client.generate_key_package() as Uint8Array;
    const poolPackages: ArrayBuffer[] =
      needed > 0
        ? [...(client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>)].map(
            (bytes) => asTransferBuffer(bytes)
          )
        : [];
    const nextState = client.save_state(pin) as Uint8Array;

    const response: GenerateKeyPackageOk = {
      type: 'generateKeyPackage:ok',
      payload: {
        fallback: asTransferBuffer(fallback),
        poolPackages,
        state: asTransferBuffer(nextState),
      },
    };

    workerScope.postMessage(response, [
      response.payload.fallback,
      ...response.payload.poolPackages,
      response.payload.state,
    ]);
    console.log('[MLS Worker] generateKeyPackage done');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response: GenerateKeyPackageErr = { type: 'generateKeyPackage:error', error: message };
    workerScope.postMessage(response);
  }
};
