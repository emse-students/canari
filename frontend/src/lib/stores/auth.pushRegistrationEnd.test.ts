import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every sign-out ends the device's push registration on the device - `clearAuth` runs it itself,
 * whatever the session, the server or the app shell does. What the device half then does (the
 * native deletion, the owed mark) is `PushNotificationService.signout.test.ts` and
 * `push_registration.rs`; this file pins that no sign-out path can skip it.
 */

const endPushRegistration = vi.fn((_cause: string) => Promise.resolve());
vi.mock('$lib/services/PushNotificationService', () => ({
  endPushRegistration: (cause: string) => endPushRegistration(cause),
}));

const currentUserId = vi.fn<() => string | null>(() => 'user-1');
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => currentUserId(),
  saveUserLocally: vi.fn(),
  clearUserLocally: () => currentUserId.mockReturnValue(null),
}));

const { clearAuth, clearAuthLocally, refresh, setToken, isRefreshCredentialProvenDead } =
  await import('$lib/stores/auth');

/** A syntactically valid JWT, so the store holds a live credential. */
function liveToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

beforeEach(() => {
  endPushRegistration.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  currentUserId.mockReturnValue('user-1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a sign-out ends the device push registration', () => {
  it('when the server revokes the session', async () => {
    setToken(liveToken());
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await clearAuth('chosen');
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the logout answers 5xx', async () => {
    setToken(liveToken());
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await clearAuth('chosen');
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the network refuses the logout', async () => {
    setToken(liveToken());
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await clearAuth('chosen');
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the session is already dead on the server', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(refresh()).rejects.toThrow();
    expect(isRefreshCredentialProvenDead()).toBe(true);

    await clearAuth('chosen');
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when another tab ended the account and nothing is revoked from here', async () => {
    await clearAuthLocally();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * WHO DECIDED IT reaches the native line, the only sign-out line a phone's logcat carries (a store
 * build forwards no WebView console). On the Mi 9T, 2026-11-15, the PIN gate's own "Se deconnecter",
 * tapped where the "Discussions" tab sits after a reload re-armed the gate, was filed as a session
 * the server had ended: logcat said a sign-out happened and nothing else.
 */
describe('a sign-out names who decided it', () => {
  it('hands the caller-named cause to the device half', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await clearAuth('pin-gate');
    expect(endPushRegistration).toHaveBeenCalledWith('pin-gate');
  });

  it('names a dead session as such, so a refusal is never mistaken for a button', async () => {
    const { endExpiredSession } = await import('$lib/composables/session/endExpiredSession');
    const signOut = vi.fn((_cause: string) => Promise.resolve());
    await endExpiredSession({
      settleRevocation: () => Promise.resolve(false),
      signOut,
      loginPath: '/login',
      log: () => {},
    });
    expect(signOut).toHaveBeenCalledWith('session-expired');
  });

  it('names the tab-local sign-out after the other tab that deleted the account', async () => {
    await clearAuthLocally();
    expect(endPushRegistration).toHaveBeenCalledWith('account-deleted-in-another-tab');
  });
});
