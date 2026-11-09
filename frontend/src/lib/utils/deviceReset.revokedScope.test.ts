// @vitest-environment happy-dom

let tauri = true;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => tauri }));

let othersPresent: boolean | Error = false;
const invokeMock = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === 'mls_other_accounts_present') {
    if (othersPresent instanceof Error) throw othersPresent;
    return othersPresent;
  }
  return undefined;
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const wipeAccountMock = vi.fn(async (_userId: string, _options: unknown): Promise<string[]> => []);
vi.mock('$lib/utils/accountLocalWipe', () => ({
  wipeDeletedAccountLocalData: (userId: string, options: unknown) =>
    wipeAccountMock(userId, options),
}));

const { revokedWipeScope, wipeAccountOfRevokedDevice } = await import('./deviceReset');
const { ACCOUNT_KEY } = await import('$lib/utils/accountLocalKeys');

/**
 * Round 6 of the review of #2919: account B removing "this phone" from another device ran the
 * factory wipe, which took account A's parked state, vault slot and keys with it. The whole install
 * goes only when no other account lives on it.
 */
describe('what a revoked device may erase', () => {
  beforeEach(() => {
    tauri = true;
    othersPresent = false;
    localStorage.clear();
    invokeMock.mockClear();
    wipeAccountMock.mockClear();
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-b'), 'device-b');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('the whole install, when nobody else lives on it', async () => {
    expect(await revokedWipeScope('user-b')).toBe('install');
    expect(invokeMock).toHaveBeenCalledWith('mls_other_accounts_present', { userId: 'user-b' });
  });

  it("the account alone, when another account's device identity is recorded here", async () => {
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'device-a');
    expect(await revokedWipeScope('user-b')).toBe('account');
  });

  it("the account alone, when another account's MLS state is on the install", async () => {
    othersPresent = true;
    expect(await revokedWipeScope('user-b')).toBe('account');
  });

  it('the account alone, accused, when the native side cannot say', async () => {
    othersPresent = new Error('mls_accounts unreadable');
    expect(await revokedWipeScope('user-b')).toBe('account');
    expect(console.error).toHaveBeenCalled();
  });

  it('the web keeps the whole-install wipe', async () => {
    tauri = false;
    localStorage.setItem(ACCOUNT_KEY.deviceId('user-a'), 'device-a');
    expect(await revokedWipeScope('user-b')).toBe('install');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the account's wipe ends the session WITHOUT a sweep, then removes that account only", async () => {
    expect(await wipeAccountOfRevokedDevice('user-b')).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith('terminer_session_mls', {
      reason: 'revoked account wipe',
      sweepState: false,
    });
    expect(invokeMock).not.toHaveBeenCalledWith('clear_app_data', undefined);
    expect(wipeAccountMock).toHaveBeenCalledWith('user-b', {
      closeThisRunsHandles: true,
      expectNativeDatabase: false,
      accountStillExists: true,
    });
  });
});
