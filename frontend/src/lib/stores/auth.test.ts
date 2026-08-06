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

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => currentUserId(),
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));

const { refresh, setSessionExpiredHandler } = await import('$lib/stores/auth');

/** A refresh response with the given status; 200 carries a syntactically valid JWT. */
function answer(status: number): Response {
  if (status !== 200) return new Response('', { status });
  const claims = btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return new Response(JSON.stringify({ access_token: `h.${claims}.s` }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<() => Promise<Response>>();

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
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    fetchMock.mockResolvedValue(answer(503));

    await expect(refresh()).rejects.toThrow();
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

  it('rearms after a successful refresh - the session answered, so the verdict is void', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await expect(refresh()).resolves.toContain('.');

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
