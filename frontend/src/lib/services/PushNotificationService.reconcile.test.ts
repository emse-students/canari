// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushAuth } from './PushNotificationService';

/**
 * THE SERVER'S ROW IS THE FACT A REGISTRATION IS OWED AGAINST, and the device states what its last
 * one came to.
 *
 * Production, 2026-11-15: 25 of the 65 `1.6.12` phones that ran that day held no `push_token` row.
 * They sent no registration and no report: the ladder ended `unauthorized` without a request, or the
 * skip key said a row stood that no longer did - and nothing re-drove it for as long as the WebView
 * lived. Now `register-device`, which runs at every unlock, answers whether the row is held: on
 * `false` the skip key goes and the registration runs again. And the outcome of every ladder, the
 * silent ones included, is kept durably and stated on that same call.
 *
 * Each case imports a FRESH module: `pushAttempted` and the start arguments are per process.
 */

/** What the OS gives `get_fcm_token`: null is a phone with no token (no Play services, APNs down). */
let osToken: string | null = 'fcm-1';

/** The push secret the native side holds, as `store_push_secret` last wrote it. */
let nativeSecret: string | null = null;

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: {
    invoke: (cmd?: string, args?: unknown) => {
      if (cmd === 'complete_owed_push_token_deletion') return Promise.resolve(true);
      if (cmd === 'end_push_registration')
        return Promise.resolve({ deleted: true, eraseTicket: 1, filesError: null });
      if (cmd === 'get_fcm_token') return Promise.resolve(osToken);
      if (cmd === 'store_push_secret') {
        nativeSecret = (args as { secret: string }).secret;
        return Promise.resolve(null);
      }
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

const LIVE: PushAuth = { tokenNow: async () => 'jwt', renew: async () => 'jwt' };

/** How many registrations reached `fetch`. */
function registrations(): number {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => String(url).includes('/api/mls/push/register')).length;
}

/** Every register call answered `status` (200 with a secret), every other call an empty 200. */
function registerAnswers(status: number): void {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (!String(url).includes('/api/mls/push/register')) return Response.json({});
    return status === 200
      ? Response.json({ pushSecret: 's' })
      : new Response(JSON.stringify({ code: 'x' }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
  });
}

async function freshModule(): Promise<typeof import('./PushNotificationService')> {
  vi.resetModules();
  return await import('./PushNotificationService');
}

/** Runs `p` to its end under fake timers, past the whole ladder. */
async function settle(p: Promise<unknown>): Promise<void> {
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(300_000);
    await p;
  } finally {
    vi.useRealTimers();
  }
}

/** Lets the registration `reconcilePushRegistration` started (not awaited) run to its end. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  osToken = 'fcm-1';
  nativeSecret = null;
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the delivery service says it holds no push registration', { timeout: 30_000 }, () => {
  it('registers AGAIN although the skip key says this token was registered - the row is the fact', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(registrations()).toBe(1);

    // The row went after the registration (a terminal send error, a session end): the skip key in
    // this WebView still names the token, and on main the device skipped for as long as it lived.
    push.reconcilePushRegistration(false);
    await drain();
    expect(registrations()).toBe(2);
  });

  it('sends nothing when the row is held', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    push.reconcilePushRegistration(true);
    await drain();
    expect(registrations()).toBe(1);
  });

  it('before the service started, it only drops the skip key, and the start registers', async () => {
    registerAnswers(200);
    sessionStorage.setItem('canari_fcm_token', 'fcm-1|fr');
    const push = await freshModule();
    push.reconcilePushRegistration(false);
    expect(sessionStorage.getItem('canari_fcm_token')).toBeNull();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(registrations()).toBe(1);
  });

  it('a ladder that ended unauthorized is re-driven once a token is accepted', async () => {
    registerAnswers(401);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    const refused = registrations();

    registerAnswers(200);
    push.reconcilePushRegistration(false);
    await drain();
    expect(registrations()).toBe(1);
    expect(refused).toBeGreaterThan(0);
  });
});

describe('what is NOT re-driven, and what is said at which level', { timeout: 30_000 }, () => {
  it('a `refused` registration is an answer: not sent again on `false`', async () => {
    registerAnswers(403);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    registerAnswers(200);
    push.reconcilePushRegistration(false);
    await drain();
    expect(registrations()).toBe(0);
  });

  it('a `no-token` phone is not re-driven on `false` (each process start asks the OS again)', async () => {
    osToken = null;
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('no-token');
    osToken = 'fcm-1';
    push.reconcilePushRegistration(false);
    await drain();
    expect(registrations()).toBe(0);
  });

  it('a first registration and an older server are said at info, never warn', async () => {
    const push = await freshModule();
    push.reconcilePushRegistration(false);
    push.reconcilePushRegistration(null);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a lost registration is warned', async () => {
    registerAnswers(401);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    vi.mocked(console.warn).mockClear();
    push.reconcilePushRegistration(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('last outcome: unauthorized')
    );
  });
});

describe('a sign-out supersedes the ladder of the account that left', { timeout: 30_000 }, () => {
  it('a ladder asleep between attempts sends nothing and records nothing after the sign-out', async () => {
    osToken = null;
    registerAnswers(200);
    const push = await freshModule();
    vi.useFakeTimers();
    try {
      const ladder = push.startPushService('https://api', LIVE, 'dev-1');
      await vi.advanceTimersByTimeAsync(40_000);
      await push.endPushRegistration('chosen');
      // The OS now has a token: the old ladder must not send it under the old user id.
      osToken = 'fcm-1';
      await vi.advanceTimersByTimeAsync(300_000);
      await ladder;
    } finally {
      vi.useRealTimers();
    }
    expect(registrations()).toBe(0);
    expect(push.pushOutcomeForReport()).toBe('none');
  });
});

describe(
  'a final outcome is never erased by a later ladder (review of #3649)',
  { timeout: 30_000 },
  () => {
    it('a `no-token` phone still states `no-token` while the NEXT process asks the OS again', async () => {
      osToken = null;
      registerAnswers(200);
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      const first = await freshModule();
      await settle(first.startPushService('https://api', LIVE, 'dev-1'));
      expect(first.pushOutcomeForReport()).toBe('no-token');

      // The next process: the login starts the ladder before the socket opens, and register-device
      // runs while it is still asking. It must state the known state, not `in-progress` or `started`.
      const next = await freshModule();
      vi.mocked(isPermissionGranted).mockReturnValueOnce(new Promise(() => {}));
      void next.startPushService('https://api', LIVE, 'dev-1');
      await drain();
      expect(next.pushOutcomeForReport()).toBe('no-token');
      // ...and a process that dies here leaves it known too.
      const third = await freshModule();
      expect(third.pushOutcomeForReport()).toBe('no-token');
    });

    it('the next account does not join the registration of the account that left', async () => {
      osToken = null;
      registerAnswers(200);
      const push = await freshModule();
      vi.useFakeTimers();
      try {
        // Account A's first attempt is polling the OS for a token.
        const ladderA = push.startPushService('https://api', LIVE, 'dev-1');
        await vi.advanceTimersByTimeAsync(10_000);
        await push.endPushRegistration('chosen');
        osToken = 'fcm-1';
        // Account B signs in while A's attempt is still in flight.
        const ladderB = push.startPushService('https://api', LIVE, 'dev-1');
        await vi.advanceTimersByTimeAsync(300_000);
        await Promise.all([ladderA, ladderB]);
      } finally {
        vi.useRealTimers();
      }
      expect(registrations()).toBe(1);
      expect(push.pushOutcomeForReport()).toBe('registered');
    });
  }
);

describe(
  'an answer to the account that left is not stored (review of #3649)',
  { timeout: 30_000 },
  () => {
    it('A answered after the sign-out and after B registered: the native secret is the one of the account signed in', async () => {
      let answerA!: (r: Response) => void;
      let calls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (!String(url).includes('/api/mls/push/register')) return Response.json({});
        calls++;
        if (calls === 1) return await new Promise<Response>((r) => (answerA = r));
        return Response.json({ pushSecret: 'secret-B' });
      });
      const push = await freshModule();
      // A's request is sent, past every check, and its answer has not come back.
      const ladderA = push.startPushService('https://api', LIVE, 'dev-1');
      await drain();
      expect(calls).toBe(1);

      await push.endPushRegistration('chosen');
      await push.startPushService('https://api', LIVE, 'dev-1');
      expect(nativeSecret).toBe('secret-B');

      answerA(Response.json({ pushSecret: 'secret-A' }));
      await ladderA;
      expect(nativeSecret).toBe('secret-B');
      expect(push.pushOutcomeForReport()).toBe('registered');
    });
  }
);

describe('the outcome a device states on register-device', { timeout: 30_000 }, () => {
  it('is `none` before any registration since the sign-out', async () => {
    const push = await freshModule();
    expect(push.pushOutcomeForReport()).toBe('none');
  });

  it('is `in-progress:<stage>` while this process registers - a fresh sign-in is not a dead process', async () => {
    registerAnswers(200);
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    const push = await freshModule();
    // The login starts the ladder before its first register-device; the ladder is still running.
    vi.mocked(isPermissionGranted).mockReturnValueOnce(new Promise(() => {}));
    void push.startPushService('https://api', LIVE, 'dev-1');
    await drain();
    // The stage names the await it is parked on: here, the notification permission.
    expect(push.pushOutcomeForReport()).toBe('in-progress:permission');
    // ...and on `false` it is not started a second time.
    push.reconcilePushRegistration(false);
    expect(console.warn).not.toHaveBeenCalled();
    // A NEXT process reads `started`: this one died inside its ladder.
    const next = await freshModule();
    expect(next.pushOutcomeForReport()).toBe('started:permission');
  });

  it('is `registered` after a registration the server answered', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('registered');
  });

  it('is `unauthorized:renewed-refused` after the ladder that used to end in silence', async () => {
    registerAnswers(401);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('unauthorized:renewed-refused');
  });

  it('is `unauthorized` when the session has no token to send at all - no request, still a record', async () => {
    registerAnswers(200);
    const push = await freshModule();
    const noToken: PushAuth = {
      tokenNow: async () => {
        throw new Error('signed out');
      },
      renew: async () => 'jwt',
    };
    await settle(push.startPushService('https://api', noToken, 'dev-1'));
    expect(registrations()).toBe(0);
    expect(push.pushOutcomeForReport()).toBe('unauthorized:other');
  });

  it('names the session verdict that stood in for a token - no request, and the branch is known', async () => {
    registerAnswers(200);
    // The verdict travels as the `tokenVerdict` field the auth types set at their throw (the real
    // types are pinned in `tokenVerdict.test.ts`); a class NAME alone says nothing.
    const cases: Array<[Error, string]> = [
      [
        Object.assign(new Error('x'), { tokenVerdict: 'session-expired' }),
        'unauthorized:session-expired',
      ],
      [
        Object.assign(new Error('x'), { tokenVerdict: 'device-revoked' }),
        'unauthorized:device-revoked',
      ],
      [Object.assign(new Error('x'), { tokenVerdict: 'signing-out' }), 'unauthorized:signing-out'],
      [
        Object.assign(new Error('x'), { tokenVerdict: 'identity-split' }),
        'unauthorized:identity-split',
      ],
      [Object.assign(new Error('x'), { name: 'SessionExpiredError' }), 'unauthorized:other'],
      [Object.assign(new Error('x'), { tokenVerdict: 'forged' }), 'unauthorized:other'],
    ];
    for (const [thrown, stated] of cases) {
      localStorage.clear();
      const push = await freshModule();
      const verdict: PushAuth = {
        tokenNow: async () => {
          throw thrown;
        },
        renew: async () => 'jwt',
      };
      await settle(push.startPushService('https://api', verdict, 'dev-1'));
      expect(push.pushOutcomeForReport()).toBe(stated);
    }
    expect(registrations()).toBe(0);
  });

  it('a process that died waiting for its OS token leaves `started:os-token`', async () => {
    registerAnswers(200);
    const push = await freshModule();
    vi.useFakeTimers();
    try {
      osToken = null;
      void push.startPushService('https://api', LIVE, 'dev-1');
      // Inside the first attempt's 30 s poll of the OS: nothing final recorded yet.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(push.pushOutcomeForReport()).toBe('in-progress:os-token');
    } finally {
      vi.useRealTimers();
    }
    const next = await freshModule();
    expect(next.pushOutcomeForReport()).toBe('started:os-token');
  });

  it("an older build's bare `started` marker is stated as it is", async () => {
    localStorage.setItem('canari_push_started', '1');
    const push = await freshModule();
    expect(push.pushOutcomeForReport()).toBe('started');
  });

  it('is `refused` after a 4xx answer', async () => {
    registerAnswers(403);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('refused');
  });

  it('survives the process - it is read by the NEXT one, on its first register-device', async () => {
    registerAnswers(401);
    const first = await freshModule();
    await settle(first.startPushService('https://api', LIVE, 'dev-1'));
    const next = await freshModule();
    expect(next.pushOutcomeForReport()).toBe('unauthorized:renewed-refused');
  });

  it('is forgotten at sign-out, so the next account starts at `none`', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    await push.endPushRegistration('chosen');
    expect(push.pushOutcomeForReport()).toBe('none');
  });
});
