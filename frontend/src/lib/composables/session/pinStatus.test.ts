/**
 * No answer from `pin-status` is never "returning" nor "first setup" (PIN audit row 16, 2026-11-20):
 * it is its own outcome, which the gate shows with a retry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SessionExpiredError } from '$lib/stores/auth';
import { askPinStatus } from './pinStatus';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ask = () =>
  askPinStatus({
    baseUrl: 'https://x',
    userId: 'u',
    getToken: async () => 'token',
    log: () => {},
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('askPinStatus', () => {
  it('answers first setup for an account with no PIN, returning for one with a PIN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ registered: false })));
    expect(await ask()).toEqual({ kind: 'first-setup' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ registered: true })));
    expect(await ask()).toEqual({ kind: 'returning' });
  });

  it('a server that cannot be reached is "unanswered", with the unreachable sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await ask()).toEqual({ kind: 'unanswered', message: m.auth_server_unreachable() });
  });

  it('a refusing status is "unanswered" too - never read as either answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 500)));
    expect(await ask()).toEqual({ kind: 'unanswered', message: m.auth_pin_status_failed() });
  });

  it('a 429 is "unanswered" with the too-many-attempts sentence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 429)));
    expect(await ask()).toEqual({ kind: 'unanswered', message: m.auth_pin_attempts_throttled() });
  });

  it('a 401 or 403 is the SESSION ending, never a retry', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)));
      expect(await ask()).toEqual({ kind: 'session-ended' });
    }
  });

  it('a refresh credential proven dead is the session ending too', async () => {
    const out = await askPinStatus({
      baseUrl: 'https://x',
      userId: 'u',
      getToken: async () => {
        throw new SessionExpiredError();
      },
      log: () => {},
    });
    expect(out).toEqual({ kind: 'session-ended' });
  });

  it('a body without a boolean is "unanswered", accused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ registered: 'yes' })));
    expect(await ask()).toEqual({ kind: 'unanswered', message: m.auth_pin_status_failed() });
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('noKeypadNoticeFor - which failures draw the gate without a keypad (row 18)', () => {
  it('a removed device, wiped now or with its wipe owed', async () => {
    const { noKeypadNoticeFor } = await import('./loginErrors');
    expect(noKeypadNoticeFor('device_revoked')).toBe(m.auth_device_revoked_here());
    expect(noKeypadNoticeFor('revoked_device_wipe_owed')).toBe(m.auth_device_revoked_here());
  });

  it('never a failure the keypad can answer', async () => {
    const { noKeypadNoticeFor } = await import('./loginErrors');
    for (const code of ['pin_mismatch', 'pin_not_set', 'server_unreachable', 'other'] as const) {
      expect(noKeypadNoticeFor(code)).toBeNull();
    }
  });
});
