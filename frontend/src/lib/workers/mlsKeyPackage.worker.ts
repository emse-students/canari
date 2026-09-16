import { mintKeyPackages } from '$lib/mls-client/keyPackages';
import { loadAndInitWasm } from '$lib/mls-client/mlsWasmLoader';
import type {
  MlsKeyPackageErr,
  MlsKeyPackageOk,
  MlsKeyPackageRequest,
} from '$lib/mls-client/mlsWorkerProtocol';

/**
 * Some generated WASM glue paths still reference `window` unconditionally.
 * In worker context we alias it to globalThis to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

/** Returns a detached ArrayBuffer copy suitable for transferable postMessage payloads. */
function asTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

type KeyPackageWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<MlsKeyPackageRequest>) => void) | null;
  postMessage: (message: MlsKeyPackageOk | MlsKeyPackageErr, transfer?: Transferable[]) => void;
};

const workerScope = self as KeyPackageWorkerScope;

/** Worker-side message handler for MLS heavy startup operations. */
workerScope.onmessage = async (event: MessageEvent<MlsKeyPackageRequest>) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'generateKeyPackage') return;

  const { userId, deviceId, deviceKeyB64, needed, state, stateWasExpected } = msg.payload;
  try {
    console.log(`[MLS Worker] generateKeyPackage start needed=${needed}`);
    const initialState = state ? new Uint8Array(state) : undefined;
    const client = await loadAndInitWasm(
      userId,
      deviceId,
      initialState,
      deviceKeyB64,
      stateWasExpected
    );

    const minted = mintKeyPackages(client, needed);
    // THE EXPIRY TRAVELS WITH THE BYTES, and a structured clone cannot carry it implicitly: the
    // buffers are TRANSFERRED (that is the whole reason this runs off-thread), so the dates ride
    // alongside as plain numbers, index for index. See `DatedKeyPackage` for why the far side
    // cannot recover them - nothing outside the WASM crate can parse an MLS KeyPackage.
    const poolPackages: ArrayBuffer[] = minted.poolPackages.map((kp) => asTransferBuffer(kp.bytes));
    const nextState = client.save_state(deviceKeyB64) as Uint8Array;

    const response: MlsKeyPackageOk = {
      type: 'generateKeyPackage:ok',
      payload: {
        fallback: asTransferBuffer(minted.fallback.bytes),
        fallbackNotAfterSecs: minted.fallback.notAfterSecs,
        poolPackages,
        poolNotAfterSecs: minted.poolPackages.map((kp) => kp.notAfterSecs),
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
    const message = String(error);
    const response: MlsKeyPackageErr = { type: 'generateKeyPackage:error', error: message };
    workerScope.postMessage(response);
  }
};
