import { describe, it, expect, vi } from 'vitest';

// The module statically imports the worker asset; stub it so Vite never resolves the real worker.
vi.mock('../workers/mlsCrypto.worker?worker', () => ({ default: class {} }));

import { createMlsCryptoWorkerSession } from './mlsCryptoWorkerSession';

/** Minimal Worker double that replies to each postMessage via a caller-supplied responder. */
class FakeWorker {
  private listeners = new Map<string, Set<(e: any) => void>>();
  posted: any[] = [];
  terminated = false;
  constructor(private responder: (msg: any) => any) {}
  addEventListener(type: string, cb: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: any) => void) {
    this.listeners.get(type)?.delete(cb);
  }
  postMessage(msg: any) {
    this.posted.push(msg);
    const resp = this.responder(msg);
    if (resp !== undefined) queueMicrotask(() => this.emit('message', { data: resp }));
  }
  emit(type: string, event: any) {
    this.listeners.get(type)?.forEach((cb) => cb(event));
  }
  terminate() {
    this.terminated = true;
  }
}

const okResponder = (msg: any) => {
  switch (msg.type) {
    case 'init':
      return { type: 'init:ok' };
    case 'decryptPage':
      return {
        type: 'decryptPage:ok',
        results: [
          { ok: true, data: new Uint8Array([7]).buffer },
          { ok: true, data: null },
          { ok: false, error: 'GAP_QUEUED' },
        ],
      };
    case 'finalize':
      return { type: 'finalize:ok', state: new Uint8Array([9, 9]).buffer };
  }
};

function makeSession(responder: (msg: any) => any) {
  const worker = new FakeWorker(responder);
  return createMlsCryptoWorkerSession(
    { userId: 'u', deviceId: 'd', groupId: 'g', state: new Uint8Array([1]) },
    () => worker as unknown as Worker
  ).then((session) => ({ session, worker }));
}

describe('createMlsCryptoWorkerSession', () => {
  it('initialises, decrypts a page (mapping data/null/error), and finalizes', async () => {
    const { session, worker } = await makeSession(okResponder);

    const results = await session.decryptPage([new Uint8Array([1]), new Uint8Array([2])]);
    expect(results).toEqual([
      { ok: true, plaintext: new Uint8Array([7]) },
      { ok: true, plaintext: null },
      { ok: false, error: 'GAP_QUEUED' },
    ]);

    const state = await session.finalize();
    expect(state).toEqual(new Uint8Array([9, 9]));

    // First posted message bootstraps the worker client.
    expect(worker.posted[0].type).toBe('init');
  });

  it('rejects and disposes the worker when init fails', async () => {
    const worker = new FakeWorker((msg) =>
      msg.type === 'init' ? { type: 'error', error: 'init failed' } : undefined
    );
    await expect(
      createMlsCryptoWorkerSession(
        { userId: 'u', deviceId: 'd', groupId: 'g', state: new Uint8Array([1]) },
        () => worker as unknown as Worker
      )
    ).rejects.toThrow('init failed');
    expect(worker.terminated).toBe(true);
  });

  it('faults after a worker error so later requests fail fast (no hang)', async () => {
    const worker = new FakeWorker((msg) => {
      if (msg.type === 'init') return { type: 'init:ok' };
      if (msg.type === 'decryptPage') return { type: 'error', error: 'worker crashed' };
      return undefined; // finalize would never get a reply → would hang without the fault guard
    });
    const session = await createMlsCryptoWorkerSession(
      { userId: 'u', deviceId: 'd', groupId: 'g', state: new Uint8Array([1]) },
      () => worker as unknown as Worker
    );

    await expect(session.decryptPage([new Uint8Array([1])])).rejects.toThrow('worker crashed');
    await expect(session.finalize()).rejects.toThrow('faulted');
  });

  it('dispose terminates the worker', async () => {
    const { session, worker } = await makeSession(okResponder);
    session.dispose();
    expect(worker.terminated).toBe(true);
  });
});
