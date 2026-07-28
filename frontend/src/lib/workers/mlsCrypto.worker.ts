import { loadAndInitWasm } from '$lib/mls-client/mlsWasmLoader';
import { wasmClientDecryptPage } from '$lib/mls-client/mlsBatchDecrypt';
import type {
  MlsCryptoDecryptPageRequest,
  MlsCryptoInitRequest,
  MlsCryptoPageResult,
  MlsCryptoWorkerRequest,
  MlsCryptoWorkerResponse,
} from '$lib/mls-client/mlsWorkerProtocol';

/**
 * Some generated WASM glue paths still reference `window` unconditionally
 * (see `frontend/src/lib/wasm/mls_wasm.js`). In worker scope there is no `window`,
 * so we alias it to `globalThis` to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

type CryptoWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<MlsCryptoWorkerRequest>) => void) | null;
  postMessage: (message: MlsCryptoWorkerResponse, transfer?: Transferable[]) => void;
};

const workerScope = self as CryptoWorkerScope;

/** The warm MLS client for the current session, kept across `decryptPage` requests. */
let client: any = null;
/** The group this session decrypts for (single group per catch-up session). */
let sessionGroupId = '';

/** Returns a detached ArrayBuffer copy suitable for transferable postMessage payloads. */
function asTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

async function handleInit(msg: MlsCryptoInitRequest): Promise<void> {
  const initialState = new Uint8Array(msg.state);
  client = await loadAndInitWasm(msg.userId, msg.deviceId, initialState, undefined);
  sessionGroupId = msg.groupId;
  workerScope.postMessage({ type: 'init:ok' });
}

function handleDecryptPage(msg: MlsCryptoDecryptPageRequest): void {
  if (!client) throw new Error('decryptPage before init');
  const inputs = msg.messages.map((buf) => new Uint8Array(buf));
  const mapped = wasmClientDecryptPage(client, sessionGroupId, inputs);

  const results: MlsCryptoPageResult[] = [];
  const transfers: Transferable[] = [];
  for (const r of mapped) {
    if (!r.ok) {
      results.push({ ok: false, error: r.error });
    } else if (r.plaintext && r.plaintext.length > 0) {
      const buf = asTransferBuffer(r.plaintext);
      results.push({ ok: true, data: buf });
      transfers.push(buf);
    } else {
      results.push({ ok: true, data: null });
    }
  }
  workerScope.postMessage({ type: 'decryptPage:ok', results }, transfers);
}

function handleFinalize(): void {
  if (!client) throw new Error('finalize before init');
  const state = asTransferBuffer(client.save_state(undefined) as Uint8Array);
  workerScope.postMessage({ type: 'finalize:ok', state }, [state]);
}

/** Stateful worker handler driving one MLS catch-up session (init -> decryptPage* -> finalize). */
workerScope.onmessage = async (event: MessageEvent<MlsCryptoWorkerRequest>) => {
  const msg = event.data;
  if (!msg) return;
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'decryptPage':
        handleDecryptPage(msg);
        break;
      case 'finalize':
        handleFinalize();
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({ type: 'error', error: message });
  }
};
