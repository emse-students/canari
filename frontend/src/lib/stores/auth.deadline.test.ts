import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every first-party request has a deadline, the refresh and the sign-out included.
 *
 * Both used a plain `fetch`: on a stalled or captive link a cold open held every `apiFetch` behind a
 * refresh that waited for the engine's own timeout (minutes), and a sign-out hung with no feedback.
 * Pinned here: the expiry is a TYPED transport failure that never logs anyone out; a refresh whose
 * head missed its deadline is re-sent ONCE with the SAME credential (so a rotation the server already
 * made is answered from its 60 s grace rather than lost); concurrent callers still share ONE flight;
 * and a sign-out completes locally when the server never answers.
 */

const clearUserLocally = vi.fn();
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: () => clearUserLocally(),
}));

// The native transport, so the credential each request presents is VISIBLE in its header - the
// "same credential" claim is then asserted rather than assumed.
vi.mock('$lib/stores/nativeRefreshToken', () => ({
  REFRESH_HEADER: 'X-Canari-Refresh',
  usesBodyRefreshTransport: () => true,
  readNativeRefreshToken: async () => 'stored-credential',
  writeNativeRefreshToken: vi.fn(async () => {}),
  clearNativeRefreshToken: vi.fn(async () => {}),
}));

const {
  refresh,
  clearAuth,
  setToken,
  setSessionExpiredHandler,
  isRefreshCredentialProvenDead,
  SessionExpiredError,
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

function rotation(): Response {
  return new Response(
    JSON.stringify({ access_token: liveToken(), refresh_token: 'rotated-credential' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** The refresh credential each recorded request presented. */
function presented(): (string | undefined)[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (init?.headers as Record<string, string> | undefined)?.['X-Canari-Refresh']
  );
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  clearUserLocally.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  // A live credential: lifts any verdict a previous case latched (the store is a module).
  setToken(liveToken());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the refresh deadline', () => {
  it('re-sends ONCE with the same credential after a deadline, and takes the answer', async () => {
    fetchMock.mockImplementationOnce(hung).mockResolvedValueOnce(rotation());

    const outcome = refresh();
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);

    await expect(outcome).resolves.toMatch(/^h\./);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(presented()).toEqual(['stored-credential', 'stored-credential']);
  });

  it('rejects typed after a second deadline - a transport failure that logs nobody out', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockImplementation(hung);

    const outcome = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
    // One deadline is not the end: the re-send is in flight, and nothing else is sent.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
    const error = await outcome;

    expect(error).toBeInstanceOf(RequestDeadlineError);
    expect(isTransportFailure(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(isRefreshCredentialProvenDead()).toBe(false);
    setSessionExpiredHandler(null);
  });

  it('keeps the single flight: concurrent callers share the request, its re-send and the failure', async () => {
    fetchMock.mockImplementation(hung);

    const first = refresh().catch((e: unknown) => e);
    const second = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2 * REFRESH_DEADLINE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(RequestDeadlineError);
    expect(b).toBe(a);
  });

  it('reads a 401 on the re-send exactly as before: a dead session, announced once', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock
      .mockImplementationOnce(hung)
      .mockResolvedValueOnce(
        new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
      );

    const outcome = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);

    expect(await outcome).toBeInstanceOf(SessionExpiredError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(isRefreshCredentialProvenDead()).toBe(true);
    setSessionExpiredHandler(null);
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

  it('says the server did not revoke when it answers a 5xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));

    await clearAuth();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('logout✗503'));
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
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
