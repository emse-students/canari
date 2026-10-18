import { loadDeviceKey, saveDeviceKey } from './deviceKeyVault';
import { accountIndexedDbNames, wipeDeletedAccountLocalData } from './accountLocalWipe';

let tauri = false;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => {});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// Every close is recorded in the SAME order array as the deletes: a delete that precedes a close
// BLOCKS on the open connection, so the order is the property, not the call.
const order: string[] = [];
vi.mock('$lib/db', () => ({
  closeCachedStore: async (id: string) => void order.push(`close-store:${id}`),
  closeOpenIndexedDbStores: async () => void order.push('close-idb'),
}));
vi.mock('$lib/db/outboxBlob', () => ({
  closeOutboxBlobStores: async () => void order.push('close-outbox'),
}));
vi.mock('$lib/utils/hex', () => ({ closeMlsDb: async () => void order.push('close-mls') }));

const KEY_A = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_B = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';

describe('wipeDeletedAccountLocalData', () => {
  beforeEach(() => {
    order.length = 0;
    tauri = false;
    invokeMock.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  it('closes every handle, then deletes ONLY that account databases by name', async () => {
    const failures = await wipeDeletedAccountLocalData('user-a');
    expect(failures).toEqual([]);
    const firstDelete = order.findIndex((o) => o.startsWith('delete:'));
    expect(order.slice(0, firstDelete)).toEqual([
      'close-store:user-a',
      'close-idb',
      'close-outbox',
      'close-mls',
    ]);
    expect(order.filter((o) => o.startsWith('delete:')).sort()).toEqual(
      accountIndexedDbNames('user-a')
        .map((n) => `delete:${n}`)
        .sort()
    );
    // Never the in-app log or another account's database.
    expect(order.join(' ')).not.toContain('user-b');
    expect(order.join(' ')).not.toContain('CanariDBLog');
  });

  it("drops that account's vault slot and leaves another account's, and the preferences", async () => {
    localStorage.setItem('canari_theme', 'dark');
    await saveDeviceKey('user-a', KEY_A);
    await saveDeviceKey('user-b', KEY_B);
    await wipeDeletedAccountLocalData('user-a');
    expect(await loadDeviceKey('user-a')).toBeNull();
    expect((await loadDeviceKey('user-b'))?.deviceKeyB64).toBe(KEY_B);
    expect(localStorage.getItem('canari_theme')).toBe('dark');
  });

  it('asks the native side to delete the one account database only on Tauri', async () => {
    await wipeDeletedAccountLocalData('user-a');
    expect(invokeMock).not.toHaveBeenCalled();
    tauri = true;
    await wipeDeletedAccountLocalData('user-a');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('delete_user_database', { userId: 'user-a' });
  });

  it('reports a failing step and still runs the others', async () => {
    tauri = true;
    invokeMock.mockRejectedValueOnce(new Error('disk'));
    await saveDeviceKey('user-a', KEY_A);
    const failures = await wipeDeletedAccountLocalData('user-a');
    expect(failures).toEqual(['the native message database']);
    expect(await loadDeviceKey('user-a')).toBeNull();
  });

  it('reports a delete another tab blocks', async () => {
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onblocked as () => void)?.());
        return req;
      },
    });
    const failures = await wipeDeletedAccountLocalData('user-a');
    expect(failures).toEqual(['the local IndexedDB databases']);
  });
});
