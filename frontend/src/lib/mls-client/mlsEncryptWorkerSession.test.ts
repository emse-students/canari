// Stub global fetch early to prevent WASM fetches via happy-dom when Worker modules are loaded.
globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array()));

// Stub Worker to prevent real Worker instantiation in tests.
globalThis.Worker = vi.fn() as any;

const encryptMlsStateOnMainThreadMock = vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9]));

vi.mock('$lib/mls-client/mlsWasmLoader', () => ({
  encryptMlsStateOnMainThread: (...args: any[]) => encryptMlsStateOnMainThreadMock(...args),
  loadMlsWasmModule: vi.fn(),
}));

// Prevent the real Worker import from triggering WASM fetches.
vi.mock('$lib/workers/mlsEncrypt.worker?worker', () => ({
  default: class MockWorker {},
}));

import { disposeMlsEncryptWorker, encryptMlsStateOffThread } from './mlsEncryptWorkerSession';

describe('encryptMlsStateOffThread', () => {
  afterEach(() => {
    disposeMlsEncryptWorker();
    vi.clearAllMocks();
  });

  it('falls back to main-thread WASM when workers are disabled', async () => {
    const plain = new Uint8Array([1, 2, 3]);
    const out = await encryptMlsStateOffThread(plain, '1234', { enabled: false });
    expect(out).toEqual(new Uint8Array([9, 9, 9]));
    expect(encryptMlsStateOnMainThreadMock).toHaveBeenCalledWith(plain, '1234');
  });

  it('encrypts via worker when enabled', async () => {
    const plain = new Uint8Array([4, 5, 6]);
    const workerFactory = vi.fn(() => {
      const listeners: Array<(event: MessageEvent) => void> = [];
      return {
        postMessage: vi.fn(
          (_msg: { type: string; payload: { plain: ArrayBuffer; pin: string } }) => {
            const encrypted = new Uint8Array([7, 8]).buffer;
            for (const listener of listeners) {
              listener({
                data: { type: 'encrypt:ok', payload: { encrypted } },
              } as MessageEvent);
            }
          }
        ),
        addEventListener: vi.fn((type: string, cb: (event: MessageEvent) => void) => {
          if (type === 'message') listeners.push(cb);
        }),
        removeEventListener: vi.fn(),
        terminate: vi.fn(),
      } as unknown as Worker;
    });

    const out = await encryptMlsStateOffThread(plain, '5678', {
      enabled: true,
      workerFactory,
    });
    expect(out).toEqual(new Uint8Array([7, 8]));
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(encryptMlsStateOnMainThreadMock).not.toHaveBeenCalled();
  });
});
