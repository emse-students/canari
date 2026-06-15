import { loadAndInitWasm } from '$lib/mls-client/mlsWasmLoader';

/**
 * Some generated WASM glue paths still reference `window` unconditionally.
 * In worker context we alias it to globalThis to keep those paths functional.
 */
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === 'undefined') {
  workerGlobal.window = workerGlobal;
}

/** Request to decrypt a batch of MLS ciphertexts off the main thread. */
interface ProcessMessagesRequest {
  type: 'processMessages';
  payload: {
    userId: string;
    deviceId: string;
    state: ArrayBuffer;
    groupId: string;
    messages: ArrayBuffer[];
  };
}

interface ProcessMessagesOk {
  type: 'processMessages:ok';
  payload: {
    results: Array<{ ok: true; data: ArrayBuffer | null } | { ok: false; error: string }>;
    state: ArrayBuffer;
  };
}

interface ProcessMessagesErr {
  type: 'processMessages:error';
  error: string;
}

/** Returns a detached ArrayBuffer copy suitable for transferable postMessage payloads. */
function asTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

type CryptoWorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<ProcessMessagesRequest>) => void) | null;
  postMessage: (message: ProcessMessagesOk | ProcessMessagesErr, transfer?: Transferable[]) => void;
};

const workerScope = self as CryptoWorkerScope;

/** Worker-side handler for sequential MLS decrypt during catch-up. */
workerScope.onmessage = async (event: MessageEvent<ProcessMessagesRequest>) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== 'processMessages') return;

  const { userId, deviceId, state, groupId, messages } = msg.payload;
  try {
    const initialState = new Uint8Array(state);
    const client = await loadAndInitWasm(userId, deviceId, initialState, undefined);

    const results: ProcessMessagesOk['payload']['results'] = [];
    for (const cipherBuf of messages) {
      const cipherBytes = new Uint8Array(cipherBuf);
      try {
        const decrypted = client.process_incoming_message_bytes(groupId, cipherBytes) as
          | Uint8Array
          | null
          | undefined;
        if (decrypted && decrypted.length > 0) {
          results.push({ ok: true, data: asTransferBuffer(decrypted) });
        } else {
          results.push({ ok: true, data: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ ok: false, error: message });
      }
    }

    const nextState = client.save_state(undefined) as Uint8Array;
    const response: ProcessMessagesOk = {
      type: 'processMessages:ok',
      payload: {
        results,
        state: asTransferBuffer(nextState),
      },
    };

    const transfers: Transferable[] = [response.payload.state];
    for (const r of results) {
      if (r.ok && r.data) transfers.push(r.data);
    }
    workerScope.postMessage(response, transfers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({ type: 'processMessages:error', error: message });
  }
};
