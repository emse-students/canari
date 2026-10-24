// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A sign-out ends the device's push registration on the device, whatever the server said.
 *
 * The device half does not depend on the session, the network or the registration marker this tab
 * keeps: it asks the native side to delete the OS token every time. A deletion that cannot complete
 * is OWED on disk and completed before anything registers again - so the token of the account that
 * left is never the one registered for the next.
 */

const tauriInvokeStub = vi.fn((_cmd?: string, _args?: unknown): Promise<unknown> =>
  Promise.resolve(null)
);

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: { invoke: tauriInvokeStub, transformCallback: vi.fn() },
  writable: true,
  configurable: true,
});

const { osPlatformStub } = vi.hoisted(() => ({ osPlatformStub: vi.fn(() => 'android') }));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: osPlatformStub }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
const { tauriRuntimeStub } = vi.hoisted(() => ({ tauriRuntimeStub: vi.fn(() => true) }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: tauriRuntimeStub }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

const { endPushRegistration, startPushService } = await import('./PushNotificationService');

/** The native answers this test controls, by command name. */
let answers: Record<string, unknown>;

function commandsCalled(): string[] {
  return tauriInvokeStub.mock.calls.map(([cmd]) => String(cmd));
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  answers = {
    get_fcm_token: 'fcm-token-1',
    end_push_registration: true,
    complete_owed_push_token_deletion: true,
  };
  tauriInvokeStub.mockImplementation((cmd?: string) =>
    Promise.resolve(cmd !== undefined && cmd in answers ? answers[cmd] : null)
  );
  osPlatformStub.mockReturnValue('android');
  tauriRuntimeStub.mockReturnValue(true);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pushSecret: 'secret-1' }),
    text: async () => '',
  });
});

describe('a sign-out on the device', () => {
  it('deletes the token natively even with no registration marker in this tab', async () => {
    expect(sessionStorage.getItem('canari_fcm_token')).toBeNull();
    await endPushRegistration();
    expect(commandsCalled()).toContain('end_push_registration');
    // No server is involved in the device half.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forgets the registration marker, so the next sign-in registers instead of skipping', async () => {
    sessionStorage.setItem('canari_fcm_token', 'fcm-token-1|fr');
    await endPushRegistration();
    expect(sessionStorage.getItem('canari_fcm_token')).toBeNull();
  });

  it('logs an error when the deletion is owed rather than done, and does not reject', async () => {
    answers.end_push_registration = false;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(endPushRegistration()).resolves.toBeUndefined();
    expect(error.mock.calls.some(([line]) => String(line).includes('OWED'))).toBe(true);
    error.mockRestore();
  });

  it('logs an error when the native step fails, and does not reject', async () => {
    tauriInvokeStub.mockImplementation(() => Promise.reject(new Error('native failure')));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(endPushRegistration()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('runs on iOS too', async () => {
    osPlatformStub.mockReturnValue('ios');
    await endPushRegistration();
    expect(commandsCalled()).toContain('end_push_registration');
  });

  it('asks nothing native where there is no push registration (web, desktop)', async () => {
    tauriRuntimeStub.mockReturnValue(false);
    await endPushRegistration();
    expect(tauriInvokeStub).not.toHaveBeenCalled();
  });
});

describe('the next registration after a sign-out', () => {
  it('completes an owed deletion BEFORE reading or registering any token', async () => {
    await startPushService('https://api', 'jwt', 'dev-1');
    const calls = commandsCalled();
    const owed = calls.indexOf('complete_owed_push_token_deletion');
    expect(owed).toBeGreaterThanOrEqual(0);
    expect(owed).toBeLessThan(calls.indexOf('get_fcm_token'));
    const registered = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes('/api/mls/push/register'));
    expect(registered).toHaveLength(1);
  });

  it('registers nothing while the deletion is still owed', async () => {
    answers.complete_owed_push_token_deletion = false;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(commandsCalled()).not.toContain('get_fcm_token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not count a registration whose push secret was not stored', async () => {
    // A first registration, so this one takes the foreground re-check path (no retry ladder).
    await startPushService('https://api', 'jwt', 'dev-1');
    sessionStorage.clear();
    vi.mocked(globalThis.fetch).mockClear();
    tauriInvokeStub.mockImplementation((cmd?: string) =>
      cmd === 'store_push_secret'
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(cmd !== undefined && cmd in answers ? answers[cmd] : null)
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startPushService('https://api', 'jwt', 'dev-1');

    // No skip key: the next attempt registers again and stores a fresh secret.
    expect(sessionStorage.getItem('canari_fcm_token')).toBeNull();
    expect(
      error.mock.calls.some(([line]) => String(line).includes('push secret was not stored'))
    ).toBe(true);
    const reports = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => !String(url).includes('/api/mls/push/register'));
    expect(reports.map(([, init]) => JSON.parse(String(init?.body)).reason)).toContain(
      'secret-not-stored'
    );
    error.mockRestore();
  });
});
