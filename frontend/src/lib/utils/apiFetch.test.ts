import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredError, setToken } from '$lib/stores/auth';
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
  return new Response('{}', { status: 200 });
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

beforeEach(() => {
  fetchMock.mockClear();
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

  it('sends the Bearer token once the refresh succeeds', async () => {
    refreshStatus = 200;

    await apiFetch(TARGET);
    const [, init] = callsTo('/api/social/feed')[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer h\./);
  });
});
