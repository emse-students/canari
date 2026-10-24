// @vitest-environment happy-dom
import { loadDeviceKey, saveDeviceKey } from './deviceKeyVault';
import {
  accountIndexedDbNames,
  decideDeletedAccountWipe,
  markDeletedAccountWipePending,
  pendingDeletedAccountWipes,
  resumePendingDeletedAccountWipes,
  REFUSED_CASE_COLLISION,
  STOPPED_ACCOUNT_LIVE,
  STOPPED_BY_SIGN_IN,
  STOPPED_NO_LONGER_OWED,
  wipeDeletedAccountLocalData,
  type AccountLiveness,
} from './accountLocalWipe';
import { ACCOUNT_KEY, keystoreAlias } from './accountLocalKeys';

/** Nobody signed in here but `liveId`, and no sign-in in flight. */
function settledAs(liveId: string | null): AccountLiveness {
  return {
    isLive: (id) => id === liveId,
    signInInFlight: () => false,
    whenSignInSettled: async () => {},
  };
}

let tauri = false;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
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

// The native `session-meta.json` store, as one map.
const sessionMeta = new Map<string, unknown>();
vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    delete: async (k: string) => sessionMeta.delete(k),
    save: async () => {},
  }),
}));

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
    expect(invokeMock).toHaveBeenCalledTimes(3);
    // The push side's plaintext files too - gated natively on the owner `push_context.json` names.
    expect(invokeMock).toHaveBeenCalledWith('delete_user_push_files', { userId: 'user-a' });
    // The data is gone, so the at-rest marker goes: the explicit reset that frees the keystore entry.
    expect(invokeMock).toHaveBeenCalledWith('cle_au_repos_oublier', { userId: 'user-a' });
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
    // A database that survived keeps its at-rest marker: the key sealing it stays guarded.
    expect(failures).toEqual(['the native message database', 'the at-rest key marker']);
    expect(invokeMock).not.toHaveBeenCalledWith('cle_au_repos_oublier', expect.anything());
    expect(await loadDeviceKey('user-a')).toBeNull();
  });

  it('reports a push-files step that failed, so the wipe stays owed', async () => {
    tauri = true;
    markDeletedAccountWipePending('user-a');
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'delete_user_push_files') throw new Error('1 push file(s) could not be removed');
    });
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([
      'the native push files',
    ]);
    expect(pendingDeletedAccountWipes()).toEqual(['user-a']);
    invokeMock.mockImplementation(async () => {});
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
      localStorage.setItem(ACCOUNT_KEY.admissionLedger(id), '{}');
      localStorage.setItem(ACCOUNT_KEY.historyClosedSeen(id), '{}');
      localStorage.setItem(ACCOUNT_KEY.seenCipher(id, 'g1'), '[]');
      localStorage.setItem(ACCOUNT_KEY.historyAudit(id, 'd1'), '1');
      localStorage.setItem(ACCOUNT_KEY.restoreKeyRegistered(id), '1');
    }
    localStorage.setItem('canari_theme', 'dark');
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyHeldNothing('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.admissionLedger('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyClosedSeen('user-a'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyClosedSeen('user-ab'))).toBe('{}');
    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher('user-a', 'g1'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.historyAudit('user-a', 'd1'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.restoreKeyRegistered('user-a'))).toBeNull();
    // An id that merely STARTS with the deleted one is another account.
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('user-ab'))).toBe('{}');
    expect(localStorage.getItem(ACCOUNT_KEY.seenCipher('user-ab', 'g1'))).toBe('[]');
    expect(localStorage.getItem(ACCOUNT_KEY.restoreKeyRegistered('user-ab'))).toBe('1');
    expect(localStorage.getItem('canari_theme')).toBe('dark');
  });

  it("deletes that account's platform keystore entry and keeps another account's", async () => {
    tauri = true;
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-a');
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-b'), 'dev-b');
    keystore.add(keystoreAlias('user-a', 'dev-a'));
    keystore.add(keystoreAlias('user-b', 'dev-b'));
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect([...keystore]).toEqual([keystoreAlias('user-b', 'dev-b')]);
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('user-a'))).toBeNull();
  });

  it('removes the entry the at-rest marker recorded, not only the one today device id names', async () => {
    // A device identity rotated after the re-key: the hardware-held key stays where the marker says.
    tauri = true;
    const recorded = keystoreAlias('user-a', 'dev-old');
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'cle_au_repos_oublier' ? recorded : undefined
    );
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-a');
    keystore.add(recorded);
    keystore.add(keystoreAlias('user-a', 'dev-a'));
    keystore.add(keystoreAlias('user-b', 'dev-b'));
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect([...keystore]).toEqual([keystoreAlias('user-b', 'dev-b')]);
    invokeMock.mockImplementation(async () => undefined);
  });

  it("removes that account's native last-active mirror and keeps another account's", async () => {
    tauri = true;
    sessionMeta.set(ACCOUNT_KEY.lastActive('user-a'), 1);
    sessionMeta.set(ACCOUNT_KEY.lastActive('user-b'), 2);
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect([...sessionMeta.keys()]).toEqual([ACCOUNT_KEY.lastActive('user-b')]);
  });

  it('keeps the device id when the keystore entry survived, so the resume can find it', async () => {
    tauri = true;
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-a');
    keystore.add(keystoreAlias('user-a', 'dev-a'));
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

  it('sweeps every per-account key of the ONE list, the unsent salon plaintext included', async () => {
    const keys = [
      ACCOUNT_KEY.salonUnsent('User-A'),
      ACCOUNT_KEY.salonReadMarks('User-A'),
      ACCOUNT_KEY.dmReadMarks('User-A'),
      ACCOUNT_KEY.notReadySince('User-A', 'g1'),
      ACCOUNT_KEY.feedStoreEpoch('User-A'),
      ACCOUNT_KEY.deviceName('User-A', 'd1'),
      ACCOUNT_KEY.legacyMlsAutosave('User-A'),
      ACCOUNT_KEY.syncGuideSeen('User-A'),
      ACCOUNT_KEY.deviceId('User-A'),
    ];
    for (const k of keys) localStorage.setItem(k, 'x');
    localStorage.setItem(ACCOUNT_KEY.salonUnsent('user-b'), 'kept');
    expect(await wipeDeletedAccountLocalData('User-A', AFTER_DELETE)).toEqual([]);
    for (const k of keys) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.salonUnsent('user-b'))).toBe('kept');
  });

  it('refuses an id that differs from another stored account only by case, and keeps it owed', async () => {
    // Three keys lower-case the id, and `canari_<id>.db` sits on a case-insensitive disk on
    // Windows and macOS: wiping Abc would take abc's unsent texts and its database with it.
    localStorage.setItem(ACCOUNT_KEY.deviceId('abc'), 'dev-1');
    localStorage.setItem(ACCOUNT_KEY.salonUnsent('abc'), 'their texts');
    markDeletedAccountWipePending('Abc');
    expect(await wipeDeletedAccountLocalData('Abc', AFTER_DELETE)).toEqual([
      REFUSED_CASE_COLLISION,
    ]);
    expect(order).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.salonUnsent('abc'))).toBe('their texts');
    expect(pendingDeletedAccountWipes()).toEqual(['Abc']);
  });

  it('removes only the legacy plaintext conversations PROVEN to be that account', async () => {
    // `_` is in the id allowlist: `canari_conv_a_` also opens account `a_b`'s keys.
    const own = ACCOUNT_KEY.legacyConversation('a', 'bob');
    const othersAccount = ACCOUNT_KEY.legacyConversation('a_b', 'carol');
    const ambiguous = ACCOUNT_KEY.legacyConversation('a', 'x_y');
    const otherPrefix = ACCOUNT_KEY.legacyConversation('ab', 'dan');
    for (const k of [own, othersAccount, ambiguous, otherPrefix]) localStorage.setItem(k, '{}');
    const warn = vi.spyOn(console, 'warn');
    expect(await wipeDeletedAccountLocalData('a', AFTER_DELETE)).toEqual([]);
    expect(localStorage.getItem(own)).toBeNull();
    expect(localStorage.getItem(othersAccount)).toBe('{}');
    expect(localStorage.getItem(ambiguous)).toBe('{}');
    expect(localStorage.getItem(otherPrefix)).toBe('{}');
    // `canari_conv_a_b_carol` and `canari_conv_a_x_y` cannot be told apart: both kept, and said.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('2 legacy plaintext'))).toBe(true);
    warn.mockRestore();
  });

  it('reports a case collision at ERROR once per start, naming the twins', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem(ACCOUNT_KEY.deviceId('xyz'), 'dev-1');
    await wipeDeletedAccountLocalData('Xyz', AFTER_DELETE);
    await wipeDeletedAccountLocalData('Xyz', AFTER_DELETE);
    const lines = error.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('letter case'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('xyz');
    error.mockRestore();
  });

  it('says so when neither a device id nor a marker names a keystore entry, instead of passing in silence', async () => {
    tauri = true;
    const warn = vi.spyOn(console, 'warn');
    expect(await wipeDeletedAccountLocalData('user-a', AFTER_DELETE)).toEqual([]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('no device id and no at-rest marker'))
    ).toBe(true);
    warn.mockRestore();
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
    await resumePendingDeletedAccountWipes(settledAs('user-b'));
    expect(order.some((o) => o.startsWith('close'))).toBe(false);
    expect(order).toContain('delete:CanariDB_user-a');
    expect(order.join(' ')).not.toContain('user-b');
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('never wipes the account this install is signed in as, and drops its marker', async () => {
    markDeletedAccountWipePending('user-a');
    await resumePendingDeletedAccountWipes(settledAs('user-a'));
    expect(order).toEqual([]);
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('waits for a sign-in in flight, and never wipes the account it signed back in', async () => {
    // The race of the review: a leftover marker for A, and A signing back in at start-up.
    markDeletedAccountWipePending('user-a');
    let live: string | null = null;
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const resume = resumePendingDeletedAccountWipes({
      isLive: (id) => id === live,
      signInInFlight: () => live === null,
      whenSignInSettled: () => landed,
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    live = 'user-a';
    land();
    await resume;
    expect(order).toEqual([]);
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('stops before the next step when the account signs in mid-wipe, and drops the marker', async () => {
    markDeletedAccountWipePending('user-a');
    await saveDeviceKey('user-a', KEY_A);
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-new');
    let live: string | null = null;
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        // The new session lands while the database delete runs.
        live = 'user-a';
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    const failures = await wipeDeletedAccountLocalData('user-a', {
      closeThisRunsHandles: false,
      expectNativeDatabase: false,
      stopIf: () => (live === 'user-a' ? 'account-live-again' : null),
    });
    expect(failures).toEqual([STOPPED_ACCOUNT_LIVE]);
    // The new session's device id and vault slot are untouched.
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('user-a'))).toBe('dev-new');
    expect((await loadDeviceKey('user-a'))?.deviceKeyB64).toBe(KEY_A);
    expect(pendingDeletedAccountWipes()).toEqual([]);
  });

  it('stops and KEEPS the marker when a sign-in of unknown account starts mid-wipe', async () => {
    markDeletedAccountWipePending('user-a');
    markDeletedAccountWipePending('user-c');
    localStorage.setItem(ACCOUNT_KEY.sendRatchetLedger('user-a'), '{}');
    let signingIn = false;
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        signingIn = true;
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    await resumePendingDeletedAccountWipes({
      isLive: () => false,
      signInInFlight: () => signingIn,
      whenSignInSettled: async () => {},
    });
    expect(localStorage.getItem(ACCOUNT_KEY.sendRatchetLedger('user-a'))).toBe('{}');
    expect(pendingDeletedAccountWipes()).toEqual(['user-a', 'user-c']);
    // The second owed wipe is not started either.
    expect(order.join(' ')).not.toContain('user-c');
    expect(STOPPED_BY_SIGN_IN).toMatch(/sign-in/);
  });

  it('stops when ANOTHER tab signs the subject in mid-wipe, which this tab token cannot see', async () => {
    // Scenario A across tabs: this tab holds no token, so `isLive` is false throughout; the other
    // tab's OIDC callback drops the shared marker while this tab's database delete runs.
    markDeletedAccountWipePending('user-a');
    await saveDeviceKey('user-a', KEY_A);
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'dev-new');
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        localStorage.removeItem('canari_deleted_account_wipe_pending:v1');
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    await resumePendingDeletedAccountWipes(settledAs(null));
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('user-a'))).toBe('dev-new');
    expect((await loadDeviceKey('user-a'))?.deviceKeyB64).toBe(KEY_A);
    expect(STOPPED_NO_LONGER_OWED).toMatch(/no longer owed/);
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

  it('wipes the DELETED account, never the one shown, when the two differ', () => {
    // Two tabs: this one shows A, the cookie now belongs to B, the DELETE removed B. B is certainly
    // gone, so its data goes; A still exists and is not named.
    expect(decideDeletedAccountWipe('user-b', 'user-a')).toEqual({
      kind: 'wipe-other-account',
      userId: 'user-b',
      displayedUserId: 'user-a',
    });
    expect(decideDeletedAccountWipe('user-b', null).kind).toBe('wipe-other-account');
  });

  it('never wipes without a readable subject, or for an id outside the allowlist', () => {
    expect(decideDeletedAccountWipe(null, 'user-a')).toEqual({ kind: 'no-subject' });
    expect(decideDeletedAccountWipe('a/b', 'a/b').kind).toBe('unwipeable-id');
  });
});
