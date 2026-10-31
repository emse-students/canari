// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "session is dead" announcement.
 *
 * `/api/auth/refresh` is the only place in the app that learns a refresh cookie is dead, and every
 * caller used to own the reaction itself. Each one that forgot produced the same failure: an app
 * that still looks signed in and shows nothing (WP-ANDROID-SESS-1, found on Android by LIFE-3).
 * These tests pin the three decisions that make the announcement trustworthy - it fires on a real
 * 401, it does NOT fire while nobody is signed in, and it fires once.
 */

const currentUserId = vi.fn<() => string | null>(() => 'user-1');
// Models the real store: dropping the local identity is what `currentUserId()` reads afterwards.
const clearUserLocally = vi.fn(() => {
  currentUserId.mockReturnValue(null);
});

// Models the real store too: a refresh restoring the identity from a token makes it current.
const saveUserLocally = vi.fn((user: { id: string }) => {
  currentUserId.mockReturnValue(user.id);
});

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => currentUserId(),
  saveUserLocally: (user: { id: string }) => saveUserLocally(user),
  clearUserLocally: () => clearUserLocally(),
}));

const {
  refresh,
  getToken,
  SessionExpiredError,
  SignOutInProgressError,
  setSessionExpiredHandler,
  setToken,
  isRefreshCredentialProvenDead,
  clearAuth,
} = await import('$lib/stores/auth');
const { IdentitySplitError, getIdentitySplit } = await import('$lib/stores/tokenIdentity.svelte');

/** A refresh response with the given status; 200 carries a syntactically valid JWT. */
function answer(status: number): Response {
  // A refusal as core-service sends it (Nest JSON): only that proves the cookie dead.
  if (status !== 200)
    return new Response(JSON.stringify({ statusCode: status, message: 'Unauthorized' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return new Response(JSON.stringify({ access_token: `h.${claims}.s` }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A syntactically valid JWT, for the cases that must hand the store a LIVE credential. */
function liveToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  currentUserId.mockReturnValue('user-1');
});

describe('the session-expired announcement', () => {
  it('stays silent when nobody is signed in - a 401 is the normal answer during login', async () => {
    // Runs first on purpose: it must not consume the one-shot latch the next tests rely on.
    currentUserId.mockReturnValue(null);
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(answer(401));

    await expect(refresh()).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('stays silent on a transient status - a 503 during a deploy is not a dead session', async () => {
    // The case above proved a credential dead, and that verdict is LATCHED - without a live one to
    // replace it this test would short-circuit and assert nothing about 503 at all.
    setToken(liveToken());
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(answer(503));

    await expect(refresh()).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("stays silent on an edge's HTML 403 - a WAF or a portal says nothing about the cookie", async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(
      new Response('<html>Access denied</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      })
    );

    const outcome = await refresh().catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stays silent on a JSON-speaking edge 403 - only Nest's envelope proves the cookie dead", async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(
      Response.json({ status: 403, title: 'Access denied' }, { status: 403 })
    );

    const outcome = await refresh().catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires once on a 401 with a signed-in user, and not again', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(answer(401));

    await expect(refresh()).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(refresh()).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not ASK again once the credential is proven dead - the answer is already known', async () => {
    // Inherits the armed latch from the case above deliberately: that state IS the case under test.
    // A 401 is a proof about a cookie, so a second request sends the same cookie for the same
    // answer. Prod measured 120 of them from one iPhone in 45 minutes, in bursts of eleven inside a
    // single second - `_pendingRefresh` collapses only the callers that overlap in time.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(answer(401));

    await expect(refresh()).rejects.toThrow('Session expired');
    await expect(refresh()).rejects.toThrow('Session expired');
    await expect(refresh()).rejects.toThrow('Session expired');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks again once a NEW credential arrives, and re-arms on its death', async () => {
    // Only a new credential can change the answer, so it is the only thing that lifts the latch.
    setToken(liveToken());
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(answer(200));
    await expect(refresh()).resolves.toContain('.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Registered only now, so this asserts what it claims: the 200 really did void the verdict,
    // rather than the handler simply being replayed the previous test's one.
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    expect(handler).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(answer(401));
    await expect(refresh()).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('replays the verdict to a handler that registers after it', () => {
    // Deliberately last, and deliberately dependent on the test above leaving the latch armed:
    // that state IS the case under test. On a cold start the first refresh 401s before the app
    // shell mounts, so the handler registers second - and on Android that raced exactly wrong,
    // leaving the PIN modal open over `/login` with the sign-in button underneath it.
    const late = vi.fn();
    setSessionExpiredHandler(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

/**
 * The latch, read from OUTSIDE the module.
 *
 * The verdict was reachable only by asking and being refused, so the encryption-PIN prompt - which
 * decides before any request - could not consult it, and was mounted on a client whose credential
 * was already known dead. The user typed a correct PIN, the modal closed a second later, and the
 * login gate appeared: a secret asked for nothing (measured on W1, 2026-08-28).
 */
describe('the dead-credential latch, as a fact a caller can read', () => {
  it('reads true while the latch is armed', () => {
    // Chained on the block above, which leaves the latch armed - the same deliberate dependency
    // every case in this file uses, because that state IS the case under test.
    expect(isRefreshCredentialProvenDead()).toBe(true);
  });

  it('reads false again once a new credential arrives', () => {
    // The accessor must answer the SAME question `refresh()` answers, so what lifts one lifts the
    // other. A reader that stayed true after a live token would decline a prompt that is now valid.
    setToken(liveToken());
    expect(isRefreshCredentialProvenDead()).toBe(false);
  });
});

describe('the fetch a refresh is made with', () => {
  it("uses the caller's fetch when one is handed over - the root load's `event.fetch`", async () => {
    // Runs after the latch was lifted above. SvelteKit warns on every navigation when a `load`
    // reaches `window.fetch`; the root layout passes its own, and it must be the one used.
    const loadFetch = vi.fn<typeof fetch>().mockResolvedValue(answer(200));
    await expect(refresh(loadFetch)).resolves.toMatch(/^h\./);
    expect(loadFetch).toHaveBeenCalledTimes(1);
    expect(String(loadFetch.mock.calls[0][0])).toContain('/api/auth/refresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the global fetch otherwise', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await expect(refresh()).resolves.toMatch(/^h\./);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * ONE LINE PER REFRESH SENT, NOT ONE PER CALLER (production 1.5.1: 653 `[A] token→refresh` lines
 * for 51 refreshes). The reason rides the request's own line; a caller that joins says nothing.
 */
describe('what a burst of callers without a usable token logs', () => {
  it('logs the refresh that leaves, once, with its reason - and nothing per caller', async () => {
    const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 30 }));
    setToken(`h.${claims}.s`);
    fetchMock.mockResolvedValue(answer(200));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await Promise.all([getToken(), getToken(), getToken(), getToken(), getToken()]);

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[A] '));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.includes('→refresh'))).toEqual([]);
    const sent = lines.filter((l) => l.startsWith('[A] refresh→ '));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\(token exp=\d+s\)$/);
    log.mockRestore();
  });
});

/**
 * THE TOKEN MUST NAME THE LOCAL IDENTITY (bench phone, 2026-10-10: MLS identity Alpha, token Delta,
 * every request a 403 and the outbox re-posting 23 times). The comparison is made where a token is
 * obtained, so it is tested here: refused, not published, not asked again, lifted only by sign-out.
 */
describe('a token for another account than the local identity', () => {
  /** A refresh answer whose token names `sub`. */
  function answerFor(sub: string): Response {
    const claims = btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
    return new Response(JSON.stringify({ access_token: `h.${claims}.s` }), { status: 200 });
  }

  it('throws IdentitySplitError, publishes nothing and keeps the MLS state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    currentUserId.mockReturnValue('alpha');
    fetchMock.mockResolvedValue(answerFor('delta'));

    const failure = await refresh().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(IdentitySplitError);
    expect(getIdentitySplit()).toEqual({ tokenSub: 'delta', localId: 'alpha' });
    expect(document.cookie).not.toContain('canari_ws_token=h');
  });

  it('does not ask the server again while the split stands', async () => {
    fetchMock.mockClear();

    await expect(refresh()).rejects.toBeInstanceOf(IdentitySplitError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is lifted by the sign-out, and a matching token is then accepted', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await clearAuth();
    expect(getIdentitySplit()).toBeNull();

    currentUserId.mockReturnValue('delta');
    fetchMock.mockResolvedValue(answerFor('delta'));
    await expect(refresh()).resolves.toMatch(/^h\./);
  });
});

/** A sign-in completing while a refresh is in flight must not turn the stale answer into a split. */
describe('a refresh superseded by a sign-in as another account', () => {
  it('is dropped: no split latched, the new session token stands', async () => {
    const claims = (sub: string) =>
      `h.${btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }))}.s`;
    setToken(claims('new-user'));
    currentUserId.mockReturnValue('old-user');
    fetchMock.mockImplementation(async () => {
      // The sign-in saves the new identity while the request is out.
      currentUserId.mockReturnValue('new-user');
      return new Response(JSON.stringify({ access_token: claims('old-user') }), { status: 200 });
    });

    await expect(refresh()).resolves.toBe(claims('new-user'));
    expect(getIdentitySplit()).toBeNull();
  });
});

/**
 * Every sign-out ends the live session, and ends it FIRST.
 *
 * Every sign-out in the app is `clearAuth()` then `/login`, and none of them reached the live chat
 * session: it kept running for a signed-out user, and on the Mi 9T (2026-10-14, 2 of 2) its
 * foreground resume raced the next OIDC callback and locked that sign-in out. `clearAuth` is the one
 * call every exit shares, so the session is ended from there.
 */
describe('the sign-out handler', () => {
  it('runs before the credential is dropped and before the server is asked to revoke it', async () => {
    const { setSignOutHandler } = await import('$lib/stores/auth');
    setToken(liveToken());
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const seen: { requests: number; socketCookie: boolean }[] = [];
    setSignOutHandler(() =>
      seen.push({
        requests: fetchMock.mock.calls.length,
        socketCookie: document.cookie.includes('canari_ws_token=h'),
      })
    );

    await clearAuth();
    setSignOutHandler(null);

    // Once, with nothing torn down yet: the teardown deregisters the push token with that credential.
    expect(seen).toEqual([{ requests: 0, socketCookie: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not stop the sign-out when the handler throws', async () => {
    const { setSignOutHandler } = await import('$lib/stores/auth');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    setSignOutHandler(() => {
      throw new Error('boom');
    });

    await clearAuth();
    setSignOutHandler(null);

    // The server-side revocation still went out, and the throw was accused rather than swallowed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sign-out handler failed'));
    error.mockRestore();
  });
});

/**
 * ONE SIGN-OUT, ONE LOGOUT (Mi 9T, `1.2.9-alpha.7`, 2026-10-17). The local identity outlived the
 * sign-out's round trip: for its whole length the app shell saw "a saved user, nobody logged in" and
 * started the "Rester connecte" unlock, whose refresh met the revocation (401), and the
 * session-expired path ran a SECOND `clearAuth` - a second `POST /api/auth/logout`, landing on
 * `/login?returnTo=/dashboard`. The identity now goes before anything is awaited.
 */
describe('the local identity at sign-out', () => {
  it('is gone before the server is asked to revoke the session', async () => {
    setToken(liveToken());
    clearUserLocally.mockClear();
    let identityAtLogout: string | null | undefined;
    fetchMock.mockImplementation(async () => {
      identityAtLogout = currentUserId();
      return new Response('', { status: 200 });
    });

    await clearAuth();

    expect(identityAtLogout).toBeNull();
    expect(clearUserLocally).toHaveBeenCalledTimes(1);
  });

  it('lets a 401 met while the logout is in flight announce nothing - no second sign-out', async () => {
    // A live credential, so the refresh below is really sent and really refused.
    setToken(liveToken());
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    let logouts = 0;
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/auth/logout')) {
        logouts++;
        // What the vault auto-login did on the phone: ask for a token while the revocation is out.
        await expect(refresh()).rejects.toThrow();
        return new Response('', { status: 200 });
      }
      return answer(401);
    });

    await clearAuth();
    setSessionExpiredHandler(null);

    expect(logouts).toBe(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it('is not restored by a refresh asked for while the logout is in flight, even one the server would answer 200', async () => {
    // The review's probe: `_doRefresh` restores the identity from a token's `sub` (the Android
    // process-kill branch), so a 200 here re-saved the user the sign-out had just cleared.
    setToken(liveToken());
    saveUserLocally.mockClear();
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    const sent: string[] = [];
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      sent.push(url.includes('/api/auth/logout') ? 'logout' : 'refresh');
      if (url.includes('/api/auth/logout')) {
        await expect(getToken()).rejects.toBeInstanceOf(SignOutInProgressError);
        return new Response('', { status: 200 });
      }
      return answer(200);
    });

    await clearAuth();
    setSessionExpiredHandler(null);

    // Not sent at all: the answer is known, and a 200 would rotate the session being revoked.
    expect(sent).toEqual(['logout']);
    expect(currentUserId()).toBeNull();
    expect(saveUserLocally).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('canari_ws_token=h');
    expect(expired).not.toHaveBeenCalled();
  });

  it('is not restored by a refresh that was already in flight when the sign-out began', async () => {
    setToken(liveToken());
    saveUserLocally.mockClear();
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    let answerRefresh: (r: Response) => void = () => {};
    let logouts = 0;
    fetchMock.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('/api/auth/logout')) {
        logouts++;
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        answerRefresh = resolve;
      });
    });

    const inFlight = refresh().catch((e: unknown) => e);
    // Let the refresh reach its request before the sign-out starts.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signOut = clearAuth();
    answerRefresh(answer(200));
    const outcome = await inFlight;
    await signOut;
    setSessionExpiredHandler(null);

    expect(outcome).toBeInstanceOf(SignOutInProgressError);
    // NOT the dead-session verdict, whose consumers answer with a second sign-out.
    expect(outcome).not.toBeInstanceOf(SessionExpiredError);
    expect(logouts).toBe(1);
    expect(currentUserId()).toBeNull();
    expect(saveUserLocally).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('canari_ws_token=h');
    expect(expired).not.toHaveBeenCalled();
  });

  it('stays refused until the LAST of two overlapping sign-outs has finished', async () => {
    // The second review's probe: A's logout held open, B run to the end, then a refresh. A flag the
    // first finisher lowered let that refresh out, carrying the CURRENT generation - so nothing
    // dropped its 200, and it re-saved the user while A was still revoking.
    setToken(liveToken());
    saveUserLocally.mockClear();
    let releaseA: (r: Response) => void = () => {};
    let logouts = 0;
    let refreshes = 0;
    fetchMock.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('/api/auth/logout')) {
        logouts++;
        if (logouts === 1) {
          return new Promise<Response>((resolve) => {
            releaseA = resolve;
          });
        }
        return Promise.resolve(new Response('', { status: 200 }));
      }
      refreshes++;
      return Promise.resolve(answer(200));
    });

    const signOutA = clearAuth();
    await vi.waitFor(() => expect(logouts).toBe(1));
    await clearAuth();

    await expect(refresh()).rejects.toBeInstanceOf(SignOutInProgressError);
    expect(refreshes).toBe(0);
    expect(currentUserId()).toBeNull();
    expect(saveUserLocally).not.toHaveBeenCalled();

    releaseA(new Response('', { status: 200 }));
    await signOutA;
  });
});
