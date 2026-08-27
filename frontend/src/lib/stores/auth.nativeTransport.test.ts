import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The refresh credential on a runtime that cannot keep the cookie.
 *
 * Measured on production 2026-08-27: an iPhone presented `cookies=[]` on 120 consecutive refreshes,
 * while A1 (Android) kept its session across an `am force-stop` with a single `refresh 200`. The gap
 * is the cookie, so on those runtimes the credential is carried explicitly - and the two things that
 * make that safe are pinned here: it is SENT, and the rotated value is on DISK before the refresh
 * resolves. The second is not a detail. Rotation makes durability part of the protocol: a lost write
 * hands the next cold start a spent token, which the server reads as a replay 60 s later and answers
 * by deleting the session row (WP-ANDROID-SESS-1).
 */

const usesBodyRefreshTransport = vi.fn(() => true);
const readNativeRefreshToken = vi.fn<() => Promise<string | null>>(async () => 'stored-credential');

/** Records both the ORDER and the fact of the write, which is what these cases are really about. */
const events: string[] = [];
const writeNativeRefreshToken = vi.fn(async (token: string) => {
  events.push('write:' + token);
});

vi.mock('$lib/stores/nativeRefreshToken', () => ({
  REFRESH_HEADER: 'X-Canari-Refresh',
  usesBodyRefreshTransport: () => usesBodyRefreshTransport(),
  readNativeRefreshToken: () => readNativeRefreshToken(),
  writeNativeRefreshToken: (t: string) => writeNativeRefreshToken(t),
  clearNativeRefreshToken: vi.fn(),
}));

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));

const { refresh, setToken } = await import('$lib/stores/auth');

function jwtWith(exp: number): string {
  return 'h.' + btoa(JSON.stringify({ sub: 'user-1', exp })) + '.s';
}

/** A rotation response, optionally carrying the new credential the way the server now does. */
function rotation(withCredential: boolean): Response {
  const body: Record<string, string> = {
    access_token: jwtWith(Math.floor(Date.now() / 1000) + 3600),
  };
  if (withCredential) body.refresh_token = 'rotated-credential';
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  events.length = 0;
  fetchMock.mockReset();
  writeNativeRefreshToken.mockClear();
  readNativeRefreshToken.mockClear();
  readNativeRefreshToken.mockResolvedValue('stored-credential');
  usesBodyRefreshTransport.mockReturnValue(true);
  vi.stubGlobal('fetch', fetchMock);
  // A live session whose access token has expired. Said explicitly because the auth store is a
  // MODULE and carries its state between cases: a 401 latches "this credential is dead" and every
  // later refresh is then answered from that fact without a request.
  setToken(jwtWith(Math.floor(Date.now() / 1000) - 10));
});

describe('the refresh credential a native runtime carries itself', () => {
  it('sends the stored credential in the header', async () => {
    fetchMock.mockImplementation(async () => {
      events.push('request');
      return rotation(true);
    });

    await expect(refresh()).resolves.toContain('.');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Canari-Refresh']).toBe('stored-credential');
  });

  it('persists the ROTATED credential before the refresh resolves', async () => {
    fetchMock.mockImplementation(async () => {
      events.push('request');
      return rotation(true);
    });

    await refresh();

    // Order, not merely occurrence: returning first would let a caller act on a session whose only
    // durable credential is the one the server has just stopped accepting.
    expect(events).toEqual(['request', 'write:rotated-credential']);
  });

  it('does not touch the store on a runtime whose cookie works', async () => {
    usesBodyRefreshTransport.mockReturnValue(false);
    fetchMock.mockResolvedValue(rotation(true));

    await refresh();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
    expect(writeNativeRefreshToken).not.toHaveBeenCalled();
    expect(readNativeRefreshToken).not.toHaveBeenCalled();
  });

  it('still asks when the store is EMPTY, because an HttpOnly cookie is invisible from here', async () => {
    // `tauri://` is the desktop origin too, where the cookie may work. Treating an empty store as
    // proof of no session would log those installs out on the very update that introduced the store.
    readNativeRefreshToken.mockResolvedValue(null);
    fetchMock.mockResolvedValue(rotation(true));

    await expect(refresh()).resolves.toContain('.');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('states the build that is asking, on EVERY platform and not just this one', async () => {
    // The server's refusal has two causes it cannot otherwise tell apart, and this parameter is the
    // discriminator: `apps/core-service/src/auth/auth.controller.ts` logs it as `client=`. Asserted
    // with the body transport OFF on purpose - the version is not transport-specific, and a refresh
    // that stops stating it makes that log line unreadable again with nothing failing anywhere.
    usesBodyRefreshTransport.mockReturnValue(false);
    fetchMock.mockResolvedValue(rotation(true));

    await refresh();

    const [url] = fetchMock.mock.calls[0] as [string];
    // Matched on the string rather than parsed: `coreUrl()` is relative in this environment, and a
    // URL constructor would fail on the shape rather than on the claim.
    expect(url).toMatch(/[?&]clientVersion=[^&\s]+/);
  });

  it('survives a server that sends no credential back, and does not pretend it stored one', async () => {
    // A server older than this transport. The rotation still happened, so this run is fine; the next
    // cold start would have only the cookie, which is worth a warning rather than a crash.
    fetchMock.mockResolvedValue(rotation(false));

    await expect(refresh()).resolves.toContain('.');
    expect(writeNativeRefreshToken).not.toHaveBeenCalled();
  });
});
