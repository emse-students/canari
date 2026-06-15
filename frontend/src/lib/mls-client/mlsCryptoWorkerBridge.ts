import type { MlsBatchProcessResult } from './IMlsService';
import MlsCryptoWorker from '../workers/mlsCrypto.worker?worker';

const WORKER_TIMEOUT_MS = 120_000;

/** Parameters for a worker-side MLS decrypt batch. */
export interface MlsCryptoWorkerBatchParams {
  userId: string;
  deviceId: string;
  groupId: string;
  state: Uint8Array;
  messages: Uint8Array[];
}

/** Result of a worker-side MLS decrypt batch including updated plain state. */
export interface MlsCryptoWorkerBatchResult {
  results: MlsBatchProcessResult[];
  state: Uint8Array;
}

/**
 * Runs sequential MLS decrypt in a dedicated worker.
 * State is transferred in/out as plain CBOR to avoid Argon2 on the main thread.
 */
export function runMlsCryptoWorkerBatch(
  params: MlsCryptoWorkerBatchParams,
  workerFactory: () => Worker = () => new MlsCryptoWorker()
): Promise<MlsCryptoWorkerBatchResult> {
  return new Promise<MlsCryptoWorkerBatchResult>((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
    };

    const onMessage = (event: MessageEvent): void => {
      if (settled) return;
      const msg = event.data as
        | {
            type: 'processMessages:ok';
            payload: {
              results: Array<{ ok: true; data: ArrayBuffer | null } | { ok: false; error: string }>;
              state: ArrayBuffer;
            };
          }
        | { type: 'processMessages:error'; error: string };
      if (!msg) return;

      if (msg.type === 'processMessages:ok') {
        settled = true;
        cleanup();
        const results: MlsBatchProcessResult[] = msg.payload.results.map((r) => {
          if (!r.ok) return { ok: false, error: r.error };
          if (r.data === null) return { ok: true, plaintext: null };
          return { ok: true, plaintext: new Uint8Array(r.data) };
        });
        resolve({
          results,
          state: new Uint8Array(msg.payload.state),
        });
      } else if (msg.type === 'processMessages:error') {
        settled = true;
        cleanup();
        reject(new Error(msg.error));
      }
    };

    const onError = (event: ErrorEvent): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(event.error ?? new Error(event.message || 'MLS crypto worker error'));
    };

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`MLS crypto worker timeout (${WORKER_TIMEOUT_MS}ms)`));
    }, WORKER_TIMEOUT_MS);

    const stateBuffer = params.state.slice().buffer;
    const messageBuffers = params.messages.map((m) => m.slice().buffer);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      {
        type: 'processMessages',
        payload: {
          userId: params.userId,
          deviceId: params.deviceId,
          state: stateBuffer,
          groupId: params.groupId,
          messages: messageBuffers,
        },
      },
      [stateBuffer, ...messageBuffers]
    );
  });
}
