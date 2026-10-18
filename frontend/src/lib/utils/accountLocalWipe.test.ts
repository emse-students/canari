import { loadDeviceKey, saveDeviceKey } from './deviceKeyVault';
import {
  accountIndexedDbNames,
  decideDeletedAccountWipe,
  markDeletedAccountWipePending,
  pendingDeletedAccountWipes,
  resumePendingDeletedAccountWipes,
  wipeDeletedAccountLocalData,
} from './accountLocalWipe';
import { ACCOUNT_KEY } from './accountLocalKeys';

let tauri = false;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => {});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// Every close is recorded in the SAME order array as the deletes: a delete that precedes a close
// BLOCKS on the open connection, so the order is the property, not the call.
const order: string[] = [];
let storeWasOpen = false;
vi.mock('$lib/db', () => ({
  closeCachedStore: async (id: string) => {
    order.push(`close-store:${id}`);
    return storeWasOpen;
  },
  closeOpenIndexedDbStores: async () => void order.push('close-idb'),
}));
vi.mock('$lib/db/outboxBlob', () => ({
  closeOutboxBlobStores: async () => void order.push('close-outbox'),
}));
vi.mock('$lib/utils/hex', () => ({ closeMlsDb: async () => void order.push('close-mls') }));

const keystore = new Set<string>();
const deleteKeyEntry = vi.fn(async (alias: string) => void keystore.delete(alias));
vi.mock('$lib/services/biometric', () => ({
  BiometricService: {
    isKeyPresent: async (alias: string) => keystore.has(alias),
    deleteKeyEntry: (alias: string) => deleteKeyEntry(alias),
  },
}));

const AFTER_DELETE = { closeThisRunsHandles: true, expectNativeDatabase: false };

const KEY_A = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_B = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';

describe('wipeDeletedAccountLocalData', () => {
  beforeEach(() => {
    order.length = 0;
    tauri = false;
    storeWasOpen = false;
    keystore.clear();
    deleteKeyEntry.mockClear();
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
    const failures = await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
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
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(await loadDeviceKey('user-a')).toBeNull();
    expect((await loadDeviceKey('user-b'))?.deviceKeyB64).toBe(KEY_B);
    expect(localStorage.getItem('canari_theme')).toBe('dark');
  });

  it('asks the native side to delete the one account database only on Tauri', async () => {
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(invokeMock).not.toHaveBeenCalled();
    tauri = true;
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('delete_user_database', {
      userId: 'user-a',
      expectDatabase: false,
    });
    // A store open in this run PROVES the database exists: the command must then find it.
    storeWasOpen = true;
    invokeMock.mockClear();
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(invokeMock).toHaveBeenCalledWith('delete_user_database', {
      userId: 'user-a',
      expectDatabase: true,
    });
  });

  it('reports a failing step and still runs the others', async () => {
    tauri = true;
    invokeMock.mockRejectedValueOnce(new Error('disk'));
    await saveDeviceKey('user-a', KEY_A);
    const failures = await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
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
    const failures = await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(failures).toEqual(['the local IndexedDB databases']);
  });
});

describe('wipeDeletedAccountLocalData - what else goes with the account', () => {
  beforeEach(() => {
    order.length = 0;
    tauri = false;
    storeWasOpen = false;
    keystore.clear();
    deleteKeyEntry.mockClear();
    invokeMock.mockClear();
    localStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  it("removes that account's per-account keys, ONLY those", async () => {
    for (const id of ['user-a', 'user-ab']) {
      localStorage.setItem(ACCOUNT_KEY.sendRatchetLedger(id), '{}');
      localStorage.setItem(ACCOUNT_KEY.historyHeldNothing(id), '{}');
      localStorage.setItem(ACCOUNT_KEY.seenCipher(id, 'g1'), '[]');
      localStorage.setItem(ACCOUNT_KEY.historyAudit(id, 'd1'), '1');
    }
    localStorage.setItem('canari_theme', 'dark');
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyHeldNothing('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher('user-a', 'g1'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyAudit('user-a', 'd1'))).toBeNull();
    // An id that merely STARTS with the deleted one is another account.
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('user-ab'))).toBe('{}');
    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher('user-ab', 'g1'))).toBe('[]');
    expect(localStorage.getItem('canari_theme')).toBe('dark');
  });

  it("deletes that account's platform keystore entry and keeps another account's", async () => {
    tauri = true;
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-a');
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-b'), 'dev-b');
    keystore.add('mls_device_key_user-a_dev-a');
    keystore.add('mls_device_key_user-b_dev-b');
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect([...keystore]).toEqual(['mls_device_key_user-b_dev-b']);
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('user-a'))).toBeNull();
  });

  it('keeps the device id when the keystore entry survived, so the resume can find it', async () => {
    tauri = true;
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-a');
    keystore.add('mls_device_key_user-a_dev-a');
    deleteKeyEntry.mockRejectedValueOnce(new Error('keystore'));
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([
      'the platform keystore entry',
    ]);
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('user-a'))).toBe('dev-a');
  });

  it('refuses an id outside the allowlist and touches nothing', async () => {
    localStorage.setItem('mls_send_ledger_a:b', '{}');
    expect(await wipeDeletedAccountLocalData('a:b', AFTER_DELETE)).toEqual(['the account id']);
    expect(order).toEqual([]);
    expect(localStorage.getItem('mls_send_ledger_a:b')).toBe('{}');
  });

  it('accepts an email-shaped subject', async () => {
    localStorage.setItem(ACCOUNT_KEY.sendRatchetLedger('a.b@x.fr'), '{}');
    expect(await wipeDeletedAccountLocalData('a.b@x.fr', AFTER_DELETE)).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('a.b@x.fr'))).toBeNull();
  });
});

describe('the pending-wipe marker', () => {
  beforeEach(() => {
    order.length = 0;
    tauri = false;
    localStorage.clear();
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
  });

  it('is cleared by a wipe that finished, and kept by one that did not', async () => {
    markDeletedAccountWipePending('user-a');
    tauri = true;
    invokeMock.mockRejectedValueOnce(new Error('disk'));
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(pendingDeletedAccountWipes()).toEqual(['user-a']);
    await wipeDeletedAccountLocalData('user-a', AFTER_DELETE);
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('is resumed at the next start WITHOUT closing this realm handles', async () => {
    markDeletedAccountWipePending('user-a');
    await resumePendingDeletedAccountWipes('user-b');
    expect(order.some((o) => o.startsWith('close'))).toBe(false);
    expect(order).toContain('delete:CanariDB_user-a');
    expect(order.join(' ')).not.toContain('user-b');
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('never wipes the account this install is signed in as, and drops its marker', async () => {
    markDeletedAccountWipePending('user-a');
    await resumePendingDeletedAccountWipes('user-a');
    expect(order).toEqual([]);
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('ignores entries outside the allowlist', () => {
    localStorage.setItem(
      'canari_deleted_account_wipe_pending:v1',
      JSON.stringify(['ok', '../x', 3])
    );
    expect(pendingDeletedAccountWipes()).toEqual(['ok']);
  });
});

describe('decideDeletedAccountWipe', () => {
  it('wipes the token subject when it is the account on screen', () => {
    expect(decideDeletedAccountWipe('user-a', 'user-a')).toEqual({
      kind: 'wipe',
      userId: 'user-a',
    });
  });

  it('NEVER wipes when the server deleted another account than the one shown', () => {
    // Two tabs: this one shows A, the cookie now belongs to B, the DELETE removed B.
    expect(decideDeletedAccountWipe('user-b', 'user-a')).toEqual({
      kind: 'subject-mismatch',
      tokenSubject: 'user-b',
      displayedUserId: 'user-a',
    });
    expect(decideDeletedAccountWipe('user-b', null).kind).toBe('subject-mismatch');
  });

  it('never wipes without a readable subject, or for an id outside the allowlist', () => {
    expect(decideDeletedAccountWipe(null, 'user-a')).toEqual({ kind: 'no-subject' });
    expect(decideDeletedAccountWipe('a/b', 'a/b').kind).toBe('unwipeable-id');
  });
});
