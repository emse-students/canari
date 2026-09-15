import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshFailedError, SessionExpiredError, setToken } from '$lib/stores/auth';
import { apiFetch } from '$lib/utils/apiFetch';

/**
 * What `apiFetch` does when it cannot get a token.
 *
 * The two failures look identical to a caller and must not be treated the same. A transport
 * failure means "no network": some routes answer without a token and offline startup depends on
 * the attempt being made. A `SessionExpiredError` means the server ANSWERED that the session is
 * dead - retrying anonymously turns "you are logged out" into "there is nothing here", which is
 * exactly the empty feed Android showed on a revoked session (WP-ANDROID-SESS-1).
 *
 * Nothing is mocked but the network: the token really is fetched through the auth store, so the
 * test exercises the seam that broke rather than a stand-in for it.
 */

const TARGET = 'https://example.test/api/social/feed';

/** Routed network: the refresh endpoint answers `refreshStatus`, everything else answers 200. */
let refreshStatus = 200;
let targetStatus = 200;
const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('/api/auth/refresh')) {
    if (refreshStatus === 0) throw new TypeError('Failed to fetch');
    if (refreshStatus !== 200) return new Response('', { status: refreshStatus });
    const claims = btoa(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
    );
    return new Response(JSON.stringify({ access_token: `h.${claims}.s` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('{}', { status: targetStatus });
});

const callsTo = (needle: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(needle));

/**
 * An access token that is already past its expiry: `getToken` drops it and goes to the refresh,
 * which is the seam every case below is about.
 */
function staleAccessToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 }));
  return `h.${claims}.s`;
}

/**
 * A token `getToken` will hand straight back, so the ONLY refresh in the run is the one the 401
 * branch performs.
 *
 * The second group needs this to be measuring what it claims. With a stale token, `getToken`
 * refreshes first and a failure there is caught by the other seam entirely - the request then
 * reaches the 401 branch by a road that makes a green result mean two things at once.
 */
function freshAccessToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

beforeEach(() => {
  fetchMock.mockClear();
  targetStatus = 200;
  vi.stubGlobal('fetch', fetchMock);
  // Each case describes the same starting point and must say so, because the auth store is a
  // MODULE and carries its state between them: a 401 latches "this refresh credential is dead" and
  // every later refresh is then answered from that fact without a request. Handing it a token that
  // is stale but real restores exactly the state these tests mean - a live session whose access
  // token has expired - instead of inheriting the previous case's verdict.
  setToken(staleAccessToken());
});

describe('apiFetch when no token can be obtained', () => {
  it('rethrows a dead session instead of issuing an anonymous request', async () => {
    refreshStatus = 401;

    await expect(apiFetch(TARGET)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(callsTo('/api/social/feed')).toHaveLength(0);
  });

  it('still attempts the request when the token failed for a transport reason', async () => {
    refreshStatus = 0;

    await expect(apiFetch(TARGET)).resolves.toHaveProperty('status', 200);
    const [, init] = callsTo('/api/social/feed')[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('names the cause it fell back FOR, so two very different failures do not read alike', async () => {
    refreshStatus = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await apiFetch(TARGET);

    const line = warn.mock.calls.map(([m]) => String(m)).find((m) => m.includes('without auth'));
    expect(line).toBeDefined();
    // A reader separating "a container is restarting" from "refresh is broken" has only this line.
    expect(line).toContain('TypeError');
    expect(line).toContain('Failed to fetch');
    warn.mockRestore();
  });

  it('sends the Bearer token once the refresh succeeds', async () => {
    refreshStatus = 200;

    await apiFetch(TARGET);
    const [, init] = callsTo('/api/social/feed')[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer h\./);
  });
});

/**
 * WHAT A 401 ON THE REQUEST ITSELF LEAVES A CALLER HOLDING.
 *
 * This branch had no test, and it flattened three outcomes into one untyped French sentence:
 * `throw new Error('Session expirée - veuillez vous reconnecter.')` for a dead cookie, for a 502
 * while a container restarted mid-deploy, and for a transport failure that reached nobody.
 * `_doRefresh` is written with some care to keep those apart - only 401/403 prove the cookie dead -
 * and this frame destroyed that one line later. A caller could then tell "you are logged out" from
 * "come back in ten seconds" only by reading the sentence, which is the distinction-in-prose this
 * repository forbids: every logout path tests `instanceof SessionExpiredError` and saw nothing.
 */
describe('apiFetch when the request itself is answered 401', () => {
  beforeEach(() => {
    // Overrides the outer stale token: see `freshAccessToken`. It must run AFTER the outer hook,
    // which is what clears the auth store's "this credential is proven dead" latch between cases.
    setToken(freshAccessToken());
  });

  it('throws SessionExpiredError when the refresh cookie is dead', async () => {
    targetStatus = 401;
    refreshStatus = 401;

    // The request went out authenticated, so the 401 is the SERVER's verdict and not a missing
    // header - which is the situation this branch exists for.
    expect(callsTo('/api/auth/refresh')).toHaveLength(0);

    await expect(apiFetch(TARGET)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('rethrows a transient refresh refusal AS ITSELF, so a deploy is not read as a logout', async () => {
    targetStatus = 401;
    refreshStatus = 502;

    const err = await apiFetch(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshFailedError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as RefreshFailedError).status).toBe(502);
  });

  it('rethrows a transport failure as itself rather than as an expired session', async () => {
    targetStatus = 401;
    refreshStatus = 0;

    const err = await apiFetch(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
  });

  it('throws SessionExpiredError when a freshly minted token is refused too', async () => {
    // The refresh SUCCEEDED and the retry was answered 401 anyway. Nothing but the session being
    // over explains that, and the logout paths have to be able to see it.
    targetStatus = 401;
    refreshStatus = 200;

    await expect(apiFetch(TARGET)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(callsTo('/api/social/feed')).toHaveLength(2);
  });
});
