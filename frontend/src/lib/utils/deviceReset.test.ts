import { wipeDeviceToFactory } from './deviceReset';

vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => false }));

/**
 * A revoked device is one its owner declared lost or stolen, so what must remain afterwards is an
 * app that has never been used - not an app that merely forgot its MLS state. These pin the two
 * properties that make that true: everything is cleared, and one store failing does not stop the
 * rest (a wipe that stops half way and reports success is the failure mode worth guarding).
 */
describe('wipeDeviceToFactory', () => {
  const deleted: string[] = [];
  // Stateful on purpose: the survey re-reads this after the wipe, so a fake that keeps answering
  // with the databases it was asked to delete would report every wipe as having left them behind.
  let present: string[] = [];

  beforeEach(() => {
    deleted.length = 0;
    present = ['CanariDB_u1', 'SomethingElse'];
    localStorage.setItem('canari_theme', 'dark');
    sessionStorage.setItem('anything', '1');

    vi.stubGlobal('indexedDB', {
      databases: async () => present.map((name) => ({ name })),
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
        present = present.filter((n) => n !== name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    vi.stubGlobal('caches', {
      keys: async () => ['media-v1', 'app-shell'],
      delete: async (n: string) => {
        deleted.push(`cache:${n}`);
        return true;
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('clears preferences, caches and the app databases', async () => {
    const failures = await wipeDeviceToFactory();

    expect(failures).toEqual([]);
    expect(localStorage.getItem('canari_theme')).toBeNull();
    expect(sessionStorage.getItem('anything')).toBeNull();
    expect(deleted).toContain('cache:media-v1');
    expect(deleted).toContain('cache:app-shell');
  });

  it("touches only Canari's own databases", async () => {
    await wipeDeviceToFactory();

    expect(deleted).toContain('CanariDB_u1');
    expect(deleted).not.toContain('SomethingElse');
  });

  it('closes the open connection first, or the delete merely blocks', async () => {
    const order: string[] = [];
    const closeStorage = vi.fn(async () => void order.push('close'));
    vi.stubGlobal('caches', {
      keys: async () => {
        order.push('caches');
        return [];
      },
      delete: async () => true,
    });

    await wipeDeviceToFactory(closeStorage);

    expect(closeStorage).toHaveBeenCalled();
    expect(order[0]).toBe('close');
  });

  it('reports the steps that failed instead of stopping at the first one', async () => {
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new Error('cache API unavailable');
      },
      delete: async () => true,
    });

    const failures = await wipeDeviceToFactory();

    // The cache step failed, and the ones after it still ran.
    expect(failures).toEqual(['the cached responses']);
    expect(localStorage.getItem('canari_theme')).toBeNull();
  });

  /**
   * "Nothing of this device remains" was printed, on 2026-08-28, on a revoked device that kept its
   * MLS database and ten localStorage keys: the wipe reported the steps it RAN, and something still
   * running had put the state back. A claim about what is GONE has to be read back to be made.
   */
  it('names what survived instead of claiming an empty device', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(String(args[0])));
    // A store that outlives its own deletion, which is exactly the shape that went unreported.
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'CanariDBMls_u1' }],
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });

    await wipeDeviceToFactory();

    expect(errors.some((e) => e.includes('SURVIVED') && e.includes('CanariDBMls_u1'))).toBe(true);
  });

  it('claims an empty device only when nothing reads back', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(String(args[0])));

    await wipeDeviceToFactory();

    expect(logs).toContain('[RESET] done - nothing of this device remains');
  });
});
