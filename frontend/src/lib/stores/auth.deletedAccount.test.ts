import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two things an account deletion asks of the auth store (WP-DEL-LOCAL):
 *
 * - a tab told by ANOTHER tab that its account was deleted signs out LOCALLY only - the refresh
 *   cookie and the native credential are one per origin, and by then they may be another account's;
 * - the resumed wipe of a deleted account can ask who is signed in here and whether a sign-in is in
 *   flight, and wait for it to land.
 */

let savedUserId: string | null = 'user-1';
const clearUserLocally = vi.fn(() => {
  savedUserId = null;
});
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => savedUserId,
  getSavedUserId: () => savedUserId,
  saveUserLocally: vi.fn(),
  clearUserLocally: () => clearUserLocally(),
}));

const clearNativeRefreshToken = vi.fn(async () => {});
vi.mock('$lib/stores/nativeRefreshToken', () => ({
  REFRESH_HEADER: 'X-Canari-Refresh',
  usesBodyRefreshTransport: () => true,
  readNativeRefreshToken: async () => 'stored-credential',
  writeNativeRefreshToken: vi.fn(async () => {}),
  clearNativeRefreshToken: () => clearNativeRefreshToken(),
}));

const { clearAuth, clearAuthLocally, accountLiveness, refresh, setToken } =
  await import('$lib/stores/auth');

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function tokenFor(sub: string): string {
  return 'h.' + btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.s';
}

beforeEach(() => {
  savedUserId = 'user-1';
  fetchMock.mockReset();
  clearUserLocally.mockClear();
  clearNativeRefreshToken.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setToken(tokenFor('user-1'));
});

describe('clearAuthLocally - the tab another tab told of a deletion', () => {
  it('forgets this tab identity and sends NO logout on the shared cookie', async () => {
    await clearAuthLocally();
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nor the native credential, which another account may hold by now.
    expect(clearNativeRefreshToken).not.toHaveBeenCalled();
    expect(accountLiveness.isLive('user-1')).toBe(false);
  });

  it('is not what clearAuth does: a deliberate sign-out still revokes', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await clearAuth();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/logout');
    expect(clearNativeRefreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('accountLiveness - what the resumed deletion wipe asks', () => {
  it('names the saved account and the subject of the live token, and nobody else', () => {
    expect(accountLiveness.isLive('user-1')).toBe(true);
    expect(accountLiveness.isLive('user-2')).toBe(false);
    savedUserId = null;
    // The token alone still says who is signed in.
    expect(accountLiveness.isLive('user-1')).toBe(true);
  });

  it('reports a refresh in flight as a sign-in, and settles once it lands', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    savedUserId = null;
    // Expire the in-memory token so a refresh is actually sent.
    setToken('not-a-jwt');
    const flight = refresh().catch(() => {});
    expect(accountLiveness.signInInFlight()).toBe(true);

    let settled = false;
    const waiting = accountLiveness.whenSignInSettled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    answer(
      new Response(JSON.stringify({ access_token: tokenFor('user-2') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await flight;
    await waiting;
    expect(settled).toBe(true);
    expect(accountLiveness.signInInFlight()).toBe(false);
  });
});
