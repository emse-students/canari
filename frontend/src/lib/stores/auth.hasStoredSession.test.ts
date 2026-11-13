import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `hasStoredSession` on a Tauri runtime with no saved user asks the server once - the recovery of a
 * localStorage an OS process kill wiped while the HttpOnly cookie survived. After a sign-out in THIS
 * process the identity was emptied on purpose and the credential revoked, so the request has a known
 * answer and is not sent (Mi 9T and iPhone 12, 2026-11-08: `refresh✗401` ~100 ms after `logout✓200`).
 */

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('$lib/services/PushNotificationService', () => ({
  endPushRegistration: () => Promise.resolve(),
}));

const currentUserId = vi.fn<() => string | null>(() => null);
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => currentUserId(),
  saveUserLocally: vi.fn(),
  clearUserLocally: () => currentUserId.mockReturnValue(null),
}));

// Whether this runtime's session can live only in the credential it carries (iOS), and that copy.
const onlyCarried = vi.fn(() => false);
const carried = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('$lib/stores/nativeRefreshToken', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/nativeRefreshToken')>()),
  onlyCarriedCredentialCanExist: () => onlyCarried(),
  readNativeRefreshToken: () => carried(),
}));

const { clearAuth, hasStoredSession } = await import('$lib/stores/auth');

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

beforeEach(() => {
  onlyCarried.mockReturnValue(false);
  carried.mockResolvedValue(null);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('hasStoredSession - the recovery refresh of a wiped identity', () => {
  it('is sent at a cold start, where a process kill may have wiped the identity', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    expect(await hasStoredSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/refresh');
  });

  it('is NOT sent where only a carried credential can exist and none is held (iOS)', async () => {
    // WKWebView keeps no cookie, so the stored credential is the only one there is: with none, the
    // server could only refuse - a request whose answer is known.
    onlyCarried.mockReturnValue(true);
    carried.mockResolvedValue(null);
    expect(await hasStoredSession()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('IS sent there when a carried credential is held', async () => {
    onlyCarried.mockReturnValue(true);
    carried.mockResolvedValue('rt-1');
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    expect(await hasStoredSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('IS sent where a cookie may carry the session (macOS, Linux, Android), even with no copy', async () => {
    onlyCarried.mockReturnValue(false);
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    expect(await hasStoredSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is NOT sent once this process has signed out', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await clearAuth();
    const sent = fetchMock.mock.calls.length; // the logout itself
    expect(await hasStoredSession()).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(sent);
  });
});
