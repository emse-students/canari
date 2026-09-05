import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every endpoint in `authSessions.ts` is answered from the presented REFRESH credential, and on a
 * native shell that credential travels in a header.
 *
 * The access token names the USER; only the refresh credential names the LOGIN, which is what
 * `currentSessionId(req)` reads on the server. `auth.ts` sends the header on `refresh` and on
 * `logout`; this file sent it nowhere, so the server fell back to whatever cookie the WebView still
 * held - by construction a value the client stopped maintaining, because rotation goes through the
 * header. It named a session that no longer exists.
 *
 * MEASURED ON DEL-7, 2026-09-05, on the phone: `POST /api/auth/refresh` answered 200 at 04:02:40,
 * and `PUT /api/auth/sessions/current/device` was answered 404 thirteen seconds later naming a sid
 * absent from the database - while the session the refresh had just rotated was alive.
 *
 * What it cost is not one log line. `bindCurrentSessionDevice` is the only writer of
 * `auth_sessions."deviceId"`, and its purge of unreachable sessions claiming a device is what closes
 * the reinstall hole - so on the native shell that hole never closed. `revokeOtherAuthSessions` is
 * worse: the server keeps the session that id names, so an unresolvable one leaves "sign out
 * everywhere else" with no reason to spare the caller.
 */

const usesBodyRefreshTransport = vi.fn(() => true);
const readNativeRefreshToken = vi.fn<() => Promise<string | null>>(async () => 'stored-credential');

vi.mock('$lib/stores/nativeRefreshToken', () => ({
  REFRESH_HEADER: 'X-Canari-Refresh',
  usesBodyRefreshTransport: () => usesBodyRefreshTransport(),
  readNativeRefreshToken: () => readNativeRefreshToken(),
  writeNativeRefreshToken: vi.fn(),
  clearNativeRefreshToken: vi.fn(),
}));

vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const { bindCurrentSessionDevice, fetchAuthSessions, revokeAuthSession, revokeOtherAuthSessions } =
  await import('./authSessions');

/** The headers of the single call made, whatever shape the caller passed them in. */
function sentHeaders(): Record<string, string> {
  expect(apiFetch).toHaveBeenCalledTimes(1);
  return (apiFetch.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
}

function answers(body: unknown) {
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => {
  vi.clearAllMocks();
  usesBodyRefreshTransport.mockReturnValue(true);
  readNativeRefreshToken.mockResolvedValue('stored-credential');
});

describe('the session API on a client that carries its own refresh credential', () => {
  it('sends it when binding the device - the write that closes the reinstall hole', async () => {
    answers({ bound: true });
    await bindCurrentSessionDevice('tauri-abc');
    expect(sentHeaders()['X-Canari-Refresh']).toBe('stored-credential');
    // And the body still declares its type: the header is ADDED, never substituted.
    expect(sentHeaders()['Content-Type']).toBe('application/json');
  });

  it('sends it when listing, so the row flagged `current` is this login', async () => {
    answers({ sessions: [] });
    await fetchAuthSessions();
    expect(sentHeaders()['X-Canari-Refresh']).toBe('stored-credential');
  });

  it('sends it when revoking one session', async () => {
    answers({ ok: true });
    await revokeAuthSession('sid-1');
    expect(sentHeaders()['X-Canari-Refresh']).toBe('stored-credential');
  });

  it('sends it when revoking the others - the id the server KEEPS is the one it resolves', async () => {
    answers({ revoked: 2 });
    await revokeOtherAuthSessions();
    expect(sentHeaders()['X-Canari-Refresh']).toBe('stored-credential');
  });
});

describe('the same calls on a client whose engine keeps the cookie', () => {
  it('sends no header at all, so presenting one cannot become a way around the cookie', async () => {
    usesBodyRefreshTransport.mockReturnValue(false);
    answers({ bound: true });
    await bindCurrentSessionDevice('web-abc');
    expect(sentHeaders()['X-Canari-Refresh']).toBeUndefined();
    expect(readNativeRefreshToken).not.toHaveBeenCalled();
  });

  it('sends no header when the native store is empty, rather than an empty one', async () => {
    readNativeRefreshToken.mockResolvedValue(null);
    answers({ bound: true });
    await bindCurrentSessionDevice('tauri-abc');
    expect('X-Canari-Refresh' in sentHeaders()).toBe(false);
  });
});
