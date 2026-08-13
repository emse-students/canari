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

  beforeEach(() => {
    deleted.length = 0;
    localStorage.setItem('canari_theme', 'dark');
    sessionStorage.setItem('anything', '1');

    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'CanariDB_u1' }, { name: 'SomethingElse' }],
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
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
});
