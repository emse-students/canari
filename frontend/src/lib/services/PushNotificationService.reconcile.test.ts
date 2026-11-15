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

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: {
    invoke: (cmd?: string) => {
      if (cmd === 'complete_owed_push_token_deletion') return Promise.resolve(true);
      if (cmd === 'end_push_registration') return Promise.resolve(true);
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

describe('the outcome a device states on register-device', { timeout: 30_000 }, () => {
  it('is `none` before any registration since the sign-out', async () => {
    const push = await freshModule();
    expect(push.pushOutcomeForReport()).toBe('none');
  });

  it('is `registered` after a registration the server answered', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('registered');
  });

  it('is `unauthorized` after the ladder that used to end in silence', async () => {
    registerAnswers(401);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    expect(push.pushOutcomeForReport()).toBe('unauthorized');
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
    expect(push.pushOutcomeForReport()).toBe('unauthorized');
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
    expect(next.pushOutcomeForReport()).toBe('unauthorized');
  });

  it('is forgotten at sign-out, so the next account starts at `none`', async () => {
    registerAnswers(200);
    const push = await freshModule();
    await settle(push.startPushService('https://api', LIVE, 'dev-1'));
    await push.endPushRegistration();
    expect(push.pushOutcomeForReport()).toBe('none');
  });
});
