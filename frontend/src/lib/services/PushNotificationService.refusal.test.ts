// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushAuth } from './PushNotificationService';

/**
 * A status is an ANSWER, and the registration ladder obeys it.
 *
 * The ladder used to send one bearer, captured when the service started, on every attempt, and to
 * retry every failure alike: a 401 was sent again seven times five seconds apart with the same dead
 * token, and the gave-up report followed with it. Now each attempt reads the CURRENT token, a 401 is
 * renewed once (`renewOn401.ts`), a 401 on the renewed token or any other 4xx stops the ladder, and
 * only a 5xx or a transport failure is retried.
 *
 * Each case imports a FRESH module: `pushAttempted` latches on the first call, and only the first call
 * of a process runs the ladder.
 */

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: {
    invoke: (cmd?: string) => {
      if (cmd === 'complete_owed_push_token_deletion') return Promise.resolve(true);
      if (cmd === 'get_fcm_token') return Promise.resolve('fcm-1');
      return Promise.resolve(null);
    },
    transformCallback: vi.fn(),
  },
  writable: true,
  configurable: true,
});

vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'android' }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

/** A token source that holds `stale` until renewed, then `fresh`. */
function renewingAuth(): PushAuth & { renew: ReturnType<typeof vi.fn> } {
  let current = 'stale';
  const renew = vi.fn(async () => {
    current = 'fresh';
    return current;
  });
  return { tokenNow: async () => current, renew };
}

/** The register calls `fetch` received, with the bearer each carried. */
function registerBearers(): string[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => String(url).includes('/api/mls/push/register'))
    .map(([, init]) => new Headers((init as RequestInit).headers).get('Authorization') ?? '');
}

/** The bodies of the unavailable reports `fetch` received. */
function reports(): Array<{ reason: string; bearer: string | null }> {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => String(url).includes('/api/mls/push/unavailable'))
    .map(([, init]) => ({
      reason: JSON.parse((init as RequestInit).body as string).reason,
      bearer: new Headers((init as RequestInit).headers).get('Authorization'),
    }));
}

/** Answers every register call with `status`, every other call with an empty 200. */
function registerAnswers(...statuses: number[]): void {
  let i = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (!String(url).includes('/api/mls/push/register')) return Response.json({});
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return status === 200
      ? Response.json({})
      : new Response(JSON.stringify({ code: 'x' }), { status });
  });
}

/**
 * Runs a FRESH module's ladder to its end under fake timers. `auth` may be built from the fresh
 * module graph, so an error class it throws is the one the service tests with `instanceof`.
 */
async function runLadder(
  auth: PushAuth | ((fresh: typeof import('$lib/utils/transportFailure')) => PushAuth)
): Promise<void> {
  vi.resetModules();
  const { startPushService } = await import('./PushNotificationService');
  const fresh = await import('$lib/utils/transportFailure');
  vi.useFakeTimers();
  try {
    const started = startPushService(
      'https://api',
      typeof auth === 'function' ? auth(fresh) : auth,
      'dev-1'
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await started;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the push registration and the answers it gets', { timeout: 30_000 }, () => {
  it('a 401 renews the token ONCE and the registration succeeds with the renewed one', async () => {
    registerAnswers(401, 200);
    const auth = renewingAuth();
    await runLadder(auth);

    expect(auth.renew).toHaveBeenCalledTimes(1);
    expect(registerBearers()).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(reports()).toHaveLength(0);
  });

  it('a 401 on the renewed token stops: no ladder of retries, and no report sent with it', async () => {
    registerAnswers(401);
    const auth = renewingAuth();
    await runLadder(auth);

    expect(auth.renew).toHaveBeenCalledTimes(1);
    // One request, one resend with the renewed token - never the seven attempts of the ladder.
    expect(registerBearers()).toEqual(['Bearer stale', 'Bearer fresh']);
    // The report would carry the same refused token: its answer is known, so it is not asked.
    expect(reports()).toHaveLength(0);
  });

  it('a session with no token to give stops before any request', async () => {
    registerAnswers(200);
    const renew = vi.fn(async () => 'never');
    await runLadder({
      tokenNow: async () => {
        throw Object.assign(new Error('expired'), { name: 'SessionExpiredError' });
      },
      renew,
    });

    expect(registerBearers()).toHaveLength(0);
    expect(renew).not.toHaveBeenCalled();
    expect(reports()).toHaveLength(0);
  });

  it('another 4xx is an answer: not retried, and reported with the current token', async () => {
    registerAnswers(403);
    const auth = renewingAuth();
    await runLadder(auth);

    expect(auth.renew).not.toHaveBeenCalled();
    expect(registerBearers()).toEqual(['Bearer stale']);
    expect(reports()).toEqual([{ reason: 'refused', bearer: 'Bearer stale' }]);
  });

  it('a 5xx keeps the existing retry ladder, each attempt reading the current token', async () => {
    registerAnswers(503);
    const auth = renewingAuth();
    await runLadder(auth);

    expect(auth.renew).not.toHaveBeenCalled();
    expect(registerBearers()).toHaveLength(7);
    expect(reports()).toEqual([{ reason: 'rejected', bearer: 'Bearer stale' }]);
  });

  it('a transport failure keeps the existing retry ladder', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/mls/push/register')) throw new TypeError('Failed to fetch');
      return Response.json({});
    });
    await runLadder(renewingAuth());

    expect(registerBearers()).toHaveLength(7);
    expect(reports().map((r) => r.reason)).toEqual(['rejected']);
  });

  it('a renewal that got no verdict is retried, not taken for a dead session', async () => {
    registerAnswers(401, 401, 200);
    let renewals = 0;
    let current = 'stale';
    await runLadder(({ RefreshFailedError }) => ({
      tokenNow: async () => current,
      renew: async () => {
        renewals += 1;
        if (renewals === 1) throw new RefreshFailedError(400);
        current = 'fresh';
        return current;
      },
    }));

    expect(renewals).toBe(2);
    expect(registerBearers()).toEqual(['Bearer stale', 'Bearer stale', 'Bearer fresh']);
    expect(reports()).toHaveLength(0);
  });
});
