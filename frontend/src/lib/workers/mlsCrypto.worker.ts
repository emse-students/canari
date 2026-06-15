import { loadAndInitWasm } from '$lib/mls-client/mlsWasmLoader';
import { wasmClientDecryptPage } from '$lib/mls-client/mlsBatchDecrypt';

/**
 * Some generated WASM glue paths still reference `window` unconditionally
 * (see `frontend/src/lib/wasm/mls_wasm.js`). In worker scope there is no `window`,
 * so we alias it to `globalThis` to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

/** Bootstraps the worker-side MLS client from a plain CBOR snapshot. */
interface InitRequest {
  type: 'init';
  userId: string;
  deviceId: string;
  groupId: string;
  state: ArrayBuffer;
}

/** Decrypts one page of ciphertexts against the warm worker client (ratchet advances). */
interface DecryptPageRequest {
  type: 'decryptPage';
  messages: ArrayBuffer[];
}

/** Reads back the accumulated plain CBOR state after all pages. */
interface FinalizeRequest {
  type: 'finalize';
}

type WorkerRequest = InitRequest | DecryptPageRequest | FinalizeRequest;

type PageResult = { ok: true; data: ArrayBuffer | null } | { ok: false; error: string };

type WorkerResponse =
  | { type: 'init:ok' }
  | { type: 'decryptPage:ok'; results: PageResult[] }
  | { type: 'finalize:ok'; state: ArrayBuffer }
  | { type: 'error'; error: string };

type CryptoWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
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

async function handleInit(msg: InitRequest): Promise<void> {
  const initialState = new Uint8Array(msg.state);
  client = await loadAndInitWasm(msg.userId, msg.deviceId, initialState, undefined);
  sessionGroupId = msg.groupId;
  workerScope.postMessage({ type: 'init:ok' });
}

function handleDecryptPage(msg: DecryptPageRequest): void {
  if (!client) throw new Error('decryptPage before init');
  const inputs = msg.messages.map((buf) => new Uint8Array(buf));
  const mapped = wasmClientDecryptPage(client, sessionGroupId, inputs);

  const results: PageResult[] = [];
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
workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
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
