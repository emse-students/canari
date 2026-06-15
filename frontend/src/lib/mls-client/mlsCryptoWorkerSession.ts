import type { MlsBatchProcessResult } from './IMlsService';
import MlsCryptoWorker from '../workers/mlsCrypto.worker?worker';

/** Max wait for any single worker request (init / page / finalize) before giving up. */
const WORKER_REQUEST_TIMEOUT_MS = 120_000;

/** Parameters to bootstrap a worker-side MLS client from a plain CBOR snapshot. */
export interface MlsCryptoWorkerSessionParams {
  userId: string;
  deviceId: string;
  groupId: string;
  /** Plain CBOR state snapshot taken from the live client (no PIN). */
  state: Uint8Array;
}

/**
 * A persistent off-thread MLS decrypt session.
 *
 * One worker is spawned per catch-up, its WASM client kept warm across pages so the
 * ratchet accumulates worker-side; the advanced state is read back once via
 * {@link finalize}. Requests are issued strictly sequentially by the caller.
 */
export interface MlsCryptoWorkerSession {
  /** Decrypts one page; the worker's ratchet advances and is retained for the next page. */
  decryptPage(messageBytesList: Uint8Array[]): Promise<MlsBatchProcessResult[]>;
  /** Reads back the accumulated plain CBOR state, then leaves the worker disposable. */
  finalize(): Promise<Uint8Array>;
  /** Terminates the worker. Idempotent. */
  dispose(): void;
}

type WorkerOk =
  | { type: 'init:ok' }
  | {
      type: 'decryptPage:ok';
      results: Array<{ ok: true; data: ArrayBuffer | null } | { ok: false; error: string }>;
    }
  | { type: 'finalize:ok'; state: ArrayBuffer };
type WorkerErr = { type: 'error'; error: string };
type WorkerResponse = WorkerOk | WorkerErr;

/**
 * Spawns a crypto worker and initialises its MLS client from `params.state`.
 * Rejects (without leaking the worker) if initialisation fails or times out.
 */
export async function createMlsCryptoWorkerSession(
  params: MlsCryptoWorkerSessionParams,
  workerFactory: () => Worker = () => new MlsCryptoWorker()
): Promise<MlsCryptoWorkerSession> {
  const worker = workerFactory();
  let disposed = false;
  /** Set after any worker-level error / timeout so later requests fail fast instead of hanging. */
  let faulted = false;
  /** Single in-flight request resolver; the session is driven sequentially. */
  let pending: {
    resolve: (msg: WorkerOk) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    worker.terminate();
  };

  const settleReject = (err: Error): void => {
    faulted = true;
    if (!pending) return;
    clearTimeout(pending.timer);
    const { reject } = pending;
    pending = null;
    reject(err);
  };

  function onMessage(event: MessageEvent): void {
    const msg = event.data as WorkerResponse | undefined;
    if (!msg || !pending) return;
    clearTimeout(pending.timer);
    const { resolve, reject } = pending;
    pending = null;
    if (msg.type === 'error') {
      // A worker-reported failure may leave its client inconsistent: fault the session so
      // finish()/finalize() fails fast instead of re-posting to a possibly-broken worker.
      faulted = true;
      reject(new Error(msg.error));
    } else {
      resolve(msg);
    }
  }

  function onError(event: ErrorEvent): void {
    settleReject(event.error ?? new Error(event.message || 'MLS crypto worker error'));
  }

  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);

  /** Posts one request and awaits its matching reply (or timeout). */
  function request(message: Record<string, unknown>, transfer: Transferable[]): Promise<WorkerOk> {
    if (disposed) return Promise.reject(new Error('MLS crypto worker session disposed'));
    if (faulted) return Promise.reject(new Error('MLS crypto worker session faulted'));
    if (pending) return Promise.reject(new Error('MLS crypto worker session is busy'));
    return new Promise<WorkerOk>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        faulted = true;
        reject(new Error(`MLS crypto worker timeout (${WORKER_REQUEST_TIMEOUT_MS}ms)`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      pending = { resolve, reject, timer };
      worker.postMessage(message, transfer);
    });
  }

  // Bootstrap: hand the snapshot to the worker (transferred, so it is detached here).
  const stateBuffer = params.state.slice().buffer;
  try {
    await request(
      {
        type: 'init',
        userId: params.userId,
        deviceId: params.deviceId,
        groupId: params.groupId,
        state: stateBuffer,
      },
      [stateBuffer]
    );
  } catch (e) {
    dispose();
    throw e;
  }

  return {
    async decryptPage(messageBytesList: Uint8Array[]): Promise<MlsBatchProcessResult[]> {
      const buffers = messageBytesList.map((m) => m.slice().buffer);
      const reply = await request({ type: 'decryptPage', messages: buffers }, buffers);
      if (reply.type !== 'decryptPage:ok') throw new Error('Unexpected worker reply');
      return reply.results.map((r) => {
        if (!r.ok) return { ok: false, error: r.error };
        if (r.data === null) return { ok: true, plaintext: null };
        return { ok: true, plaintext: new Uint8Array(r.data) };
      });
    },
    async finalize(): Promise<Uint8Array> {
      const reply = await request({ type: 'finalize' }, []);
      if (reply.type !== 'finalize:ok') throw new Error('Unexpected worker reply');
      return new Uint8Array(reply.state);
    },
    dispose,
  };
}
