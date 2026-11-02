// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

/**
 * THE REVOKED ACCOUNT'S KEYSTORE ENTRY GOES, ON THE PATH THE APP RUNS (round 7 of the review of
 * #2919).
 *
 * A revoked device another account still uses wipes ONE account (`wipeAccountOfRevokedDevice`). The
 * session end used to run first and erase the device id and the at-rest marker - the two halves of the
 * keystore alias - so the wipe logged "no keystore entry can be named, none removed" and the revoked
 * account's key stayed in the platform keystore. Run over the REAL `wipeRevokedDevice`, the REAL
 * session end, the REAL scope question and the REAL account wipe: stand-ins only for the native
 * commands, the keystore, the native store plugin and the IndexedDB deletes.
 */

vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/utils/openExternal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/openExternal')>()),
  isTauriRuntime: () => true,
}));

const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  switch (cmd) {
    case 'mls_other_accounts_present':
      return true;
    case 'cle_au_repos_oublier':
      return null;
    default:
      return 0;
  }
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const keystore = new Set<string>();
const deleteKeyEntry = vi.fn(async (alias: string) => {
  keystore.delete(alias);
});
vi.mock('$lib/services/biometric', () => ({
  BiometricService: {
    isKeyPresent: async (alias: string) => keystore.has(alias),
    deleteKeyEntry: (alias: string) => deleteKeyEntry(alias),
    forget: vi.fn(async () => {}),
  },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({ delete: async () => false, save: async () => {} }),
}));
vi.mock('$lib/utils/indexedDbDelete', () => ({ deleteIndexedDbByName: async () => true }));
vi.mock('$lib/utils/nativeMlsSession', () => ({ endNativeMlsSession: vi.fn(async () => {}) }));
// The auth store's own sign-out reaches platform plugins this file does not stand in for; what is
// under test is the order of the session end and the account wipe around it.
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  clearAuth: vi.fn(async () => {}),
}));
vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  currentUserId: () => 'alice',
  clearUserLocally: vi.fn(),
}));

const { ACCOUNT_KEY, keystoreAlias } = await import('$lib/utils/accountLocalKeys');
const { pendingDeletedAccountWipes, wipeReasonOf, forgetDeletedAccountOnSignIn } =
  await import('$lib/utils/deletedAccountMarker');
const { wipeRevokedDevice } = await import('./sessionAuth');

function session(): { ctx: SessionContext; cb: ChatSessionCallbacks; logs: () => string } {
  let wiping = false;
  const known: Partial<SessionContext> = {
    getUserId: () => 'alice',
    isWipingRevokedDevice: () => wiping,
    setWipingRevokedDevice: (v) => (wiping = v),
    whenMlsRetired: async () => {},
    getStorage: () => null,
    timers: { reconnect: null, health: null, syncWatchdog: null, connectionWatchdog: null },
  };
  const ctx = new Proxy(known as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())),
  }) as unknown as SessionContext;
  const cb = new Proxy(
    { log: vi.fn(), conversations: new Map(), onSessionExpired: vi.fn() } as Record<
      string | symbol,
      unknown
    >,
    { get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())) }
  ) as unknown as ChatSessionCallbacks;
  const logged: string[] = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  return { ctx, cb, logs: () => logged.join('\n') };
}

describe('the revoked wipe of ONE account on an install another account uses', () => {
  beforeEach(() => {
    localStorage.clear();
    keystore.clear();
    invoke.mockClear();
    deleteKeyEntry.mockClear();
  });

  it("removes the revoked account's keystore entry, named by the device id the session end left", async () => {
    localStorage.setItem(ACCOUNT_KEY.deviceId('alice'), 'device-a');
    localStorage.setItem(ACCOUNT_KEY.deviceId('bob'), 'device-b');
    keystore.add(keystoreAlias('alice', 'device-a'));
    keystore.add(keystoreAlias('bob', 'device-b'));
    const s = session();

    await wipeRevokedDevice(s.ctx, s.cb);

    expect(deleteKeyEntry).toHaveBeenCalledWith(keystoreAlias('alice', 'device-a'));
    expect(keystore.has(keystoreAlias('alice', 'device-a'))).toBe(false);
    expect(keystore.has(keystoreAlias('bob', 'device-b')), "the other account's entry").toBe(true);
    expect(s.logs()).not.toContain('no keystore entry can be named');
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('alice'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.deviceId('bob'))).toBe('device-b');
    expect(pendingDeletedAccountWipes(), 'nothing failed, nothing owed').toEqual([]);
    expect(invoke).toHaveBeenCalledWith('delete_user_mls_state', { userId: 'alice' });
  });

  it('a step that fails is accused and the wipe stays owed, to resume at the next start', async () => {
    // Another device of alice: a completed reset is remembered per device for the module's life.
    localStorage.setItem(ACCOUNT_KEY.deviceId('alice'), 'device-a2');
    localStorage.setItem(ACCOUNT_KEY.deviceId('bob'), 'device-b');
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'mls_other_accounts_present') return true;
      if (cmd === 'cle_au_repos_oublier') return null;
      if (cmd === 'delete_user_mls_state')
        throw new Error('a foreground MLS session is still open');
      return 0;
    });
    const s = session();

    await wipeRevokedDevice(s.ctx, s.cb);

    expect(pendingDeletedAccountWipes()).toEqual(['alice']);
    expect(wipeReasonOf('alice')).toBe('revoked');
    expect(s.logs()).toContain("the revoked account's wipe did not finish: the parked MLS state");
    // ROUND 8 (L-5): a revoked account is not a deleted one, and no line says it is.
    expect(s.logs()).toContain('[REVOKED-LOCAL] alice');
    expect(s.logs()).not.toContain('[DEL-LOCAL]');

    // Its owner signs in online on this device again: the owed wipe is dropped, told as a revocation.
    forgetDeletedAccountOnSignIn('alice');
    expect(pendingDeletedAccountWipes()).toEqual([]);
    expect(s.logs()).toContain('signed in again online on this device after its revocation');
    expect(s.logs()).not.toContain('after its erasure');
  });
});
