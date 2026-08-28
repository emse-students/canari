import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The device that cannot get a push token, and the report that says so.
 *
 * THE CASE THAT WENT UNNOTICED FOR A PLATFORM'S WHOLE LIFE. Measured on production 2026-08-27:
 * `push_token` held 49 `android` rows and had never held ONE `ios` row, so no message alert, no
 * mention and no CallKit ring had ever been deliverable to an iPhone - and nothing anywhere said so.
 * The client warned to its own console, which on iOS cannot be opened from a Windows machine, the
 * server was never told, and a missing row is indistinguishable from a device nobody opened. The
 * healthy platform's 49 rows stood in for both.
 *
 * IN ITS OWN FILE ON PURPOSE. `pushAttempted` is module state that latches on the first call, and
 * `startPushService`'s re-check path deliberately returns early without reporting - so a case that
 * needs the FIRST launch of a process needs a module nothing has called yet. Sharing
 * `PushNotificationService.test.ts` silently exercised that early return instead, and the test
 * passed nothing while looking like it covered this.
 */

const tauriInvokeStub = vi.fn((_cmd?: string): Promise<unknown> => Promise.resolve(null));

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: { invoke: tauriInvokeStub, transformCallback: vi.fn() },
  writable: true,
  configurable: true,
});

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

const { startPushService } = await import('./PushNotificationService');

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  tauriInvokeStub.mockImplementation(() => Promise.resolve(null));
  Object.defineProperty(navigator, 'userAgent', { value: 'android', configurable: true });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => '',
  });
});

describe('a device the OS never gives a push token', () => {
  it('reports it to the server, ONCE, and only after every retry is spent', async () => {
    // The "once, at the end" half matters as much as the reporting: an early attempt can fail for a
    // reason the next one fixes - that is what the retry loop is for on slow Android token
    // generation - so reporting one of those would file a defect against a device that goes on to
    // work.
    vi.useFakeTimers();
    try {
      const started = startPushService('https://api', 'jwt', 'dev-1');
      // Covers the 30 s token poll plus all six 5 s retries, each with a poll of its own.
      await vi.advanceTimersByTimeAsync(300_000);
      await started;

      const calls = vi.mocked(globalThis.fetch).mock.calls;
      const reports = calls.filter(([url]) => String(url).includes('/api/mls/push/unavailable'));
      expect(reports).toHaveLength(1);
      const body = JSON.parse((reports[0][1] as RequestInit).body as string);
      expect(body).toMatchObject({ deviceId: 'dev-1', platform: 'android', reason: 'no-token' });
      // With no token there is nothing to register, so no registration may have been attempted.
      expect(calls.filter(([url]) => String(url).includes('/push/register'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the cause the native layer named, not the symptom this layer can see', async () => {
    // `no-token` is where this layer's sight ends, and on iOS it covers two faults whose fixes are
    // opposite: APNs never answering, versus APNs answering and FCM refusing. The native side has
    // already branched on exactly that and says which; carrying its word through is what keeps the
    // next reader from having to learn it by shipping a build.
    //
    // A FRESH MODULE, for the reason this file exists at all: `pushAttempted` latches on the first
    // call, and the test above already spent it. Re-importing is the only way to reach the ladder
    // a second time.
    vi.resetModules();
    const { startPushService: freshStart } = await import('./PushNotificationService');
    tauriInvokeStub.mockImplementation((cmd?: string) =>
      Promise.resolve(cmd === 'get_push_diagnostic' ? 'no-apns-token' : null)
    );

    vi.useFakeTimers();
    try {
      const started = freshStart('https://api', 'jwt', 'dev-1');
      await vi.advanceTimersByTimeAsync(300_000);
      await started;

      const reports = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url]) => String(url).includes('/api/mls/push/unavailable'));
      expect(reports).toHaveLength(1);
      const body = JSON.parse((reports[0][1] as RequestInit).body as string);
      expect(body.reason).toBe('no-apns-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
