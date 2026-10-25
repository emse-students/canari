import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every sign-out ends the device's push registration on the device - `clearAuth` runs it itself,
 * whatever the session, the server or the app shell does. What the device half then does (the
 * native deletion, the owed mark) is `PushNotificationService.signout.test.ts` and
 * `push_registration.rs`; this file pins that no sign-out path can skip it.
 */

const endPushRegistration = vi.fn(() => Promise.resolve());
vi.mock('$lib/services/PushNotificationService', () => ({
  endPushRegistration: () => endPushRegistration(),
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
    await clearAuth();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the logout answers 5xx', async () => {
    setToken(liveToken());
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await clearAuth();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the network refuses the logout', async () => {
    setToken(liveToken());
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await clearAuth();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when the session is already dead on the server', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
    );
    await expect(refresh()).rejects.toThrow();
    expect(isRefreshCredentialProvenDead()).toBe(true);

    await clearAuth();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('when another tab ended the account and nothing is revoked from here', async () => {
    await clearAuthLocally();
    expect(endPushRegistration).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
