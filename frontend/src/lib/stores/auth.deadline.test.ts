import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every first-party request has a deadline, the refresh and the sign-out included.
 *
 * Both used a plain `fetch`: on a stalled or captive link a cold open held every `apiFetch` behind a
 * refresh that waited for the engine's own timeout (minutes), and a sign-out hung with no feedback.
 * Pinned here: the expiry is a TYPED transport failure that never logs anyone out, concurrent callers
 * still share ONE request, and a sign-out completes locally when the server never answers.
 */

const clearUserLocally = vi.fn();
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: () => clearUserLocally(),
}));

const {
  refresh,
  clearAuth,
  setToken,
  setSessionExpiredHandler,
  isRefreshCredentialProvenDead,
  REFRESH_DEADLINE_MS,
  LOGOUT_DEADLINE_MS,
} = await import('$lib/stores/auth');
const { RequestDeadlineError } = await import('$lib/utils/requestDeadline');
const { isTransportFailure } = await import('$lib/utils/transportFailure');

/** A server that accepts the socket and never answers: settles only when the request is aborted. */
function hung(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    );
  });
}

function liveToken(): string {
  return (
    'h.' + btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })) + '.s'
  );
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  clearUserLocally.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setToken(liveToken());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the refresh deadline', () => {
  it('rejects a hung refresh as a RequestDeadlineError, a transport failure that logs nobody out', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockImplementation(hung);

    const outcome = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
    const error = await outcome;

    expect(error).toBeInstanceOf(RequestDeadlineError);
    expect(isTransportFailure(error)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(isRefreshCredentialProvenDead()).toBe(false);
    setSessionExpiredHandler(null);
  });

  it('keeps the refresh single-flight: concurrent callers share ONE request and its failure', async () => {
    fetchMock.mockImplementation(hung);

    const first = refresh().catch((e: unknown) => e);
    const second = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(RequestDeadlineError);
    expect(b).toBe(a);
  });

  it('does not latch anything: the next caller asks again, and an answer is taken', async () => {
    fetchMock.mockImplementation(hung);
    const outcome = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
    await outcome;

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: liveToken() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(refresh()).resolves.toMatch(/^h\./);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves most of the server rotation grace (60 s) to that next refresh', () => {
    // A deadline that fires after the server rotated loses the response, not the session, only if
    // the re-presentation of the old token lands inside `ROTATION_GRACE_SECONDS`.
    expect(REFRESH_DEADLINE_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('the sign-out deadline', () => {
  it('completes the local sign-out when the server never answers, and says it did not revoke', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(hung);

    let done = false;
    const signOut = clearAuth().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(LOGOUT_DEADLINE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await signOut;

    // Resolved, so the caller's navigation to `/login` (or MiConnect's end-session) runs next.
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/logout');
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did NOT revoke'));
    warn.mockRestore();
  });

  it('logs the answer when the server does revoke', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await clearAuth();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('logout✓200'));
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
