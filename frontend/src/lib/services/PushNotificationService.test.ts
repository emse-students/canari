// Stub Tauri internals before any import so the CJS module picks them up.
// Vitest v4 does not support vi.mock for CJS modules like @tauri-apps/api/core.
// We therefore stub the global object that the CJS module uses internally.
const tauriInvokeStub = vi.fn((cmd: string) => {
  if (cmd === 'get_fcm_token') return Promise.resolve('tok-123');
  return Promise.resolve(undefined);
});

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: {
    invoke: tauriInvokeStub,
    transformCallback: vi.fn(),
  },
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
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

import { startPushService } from './PushNotificationService';

describe('startPushService - rotation de token FCM', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    // The service asks the OS, not the user agent, so this is what decides the platform now.
    osPlatformStub.mockReturnValue('android');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pushSecret: 'secret' }),
      text: async () => '',
    });
  });

  it('1er appel enregistre, ré-appel inchangé skip, ré-appel après rotation ré-enregistre', async () => {
    // 1er appel : enregistrement complet.
    tauriInvokeStub.mockImplementation((cmd: string) => {
      if (cmd === 'get_fcm_token') return Promise.resolve('tok-123');
      return Promise.resolve(undefined);
    });

    await startPushService('https://api', 'jwt', 'dev-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // The Android token is tagged platform: 'android' for the FCM gateway.
    expect(JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as any).body).platform).toBe(
      'android'
    );

    // Re-call (foreground return) without token change -> no re-POST.
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // FCM token rotated (onNewToken wrote the new one locally) -> re-call re-registers.
    tauriInvokeStub.mockImplementation((cmd: string) => {
      if (cmd === 'get_fcm_token') return Promise.resolve('tok-456');
      return Promise.resolve(undefined);
    });

    await startPushService('https://api', 'jwt', 'dev-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const lastBody = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[1][1] as any).body);
    expect(lastBody.token).toBe('tok-456');
  });

  it('iOS enregistre le token FCM avec platform: ios (FCM relaie vers APNs)', async () => {
    osPlatformStub.mockReturnValue('ios');

    tauriInvokeStub.mockImplementation((cmd: string) => {
      if (cmd === 'get_fcm_token') return Promise.resolve('tok-ios');
      return Promise.resolve(undefined);
    });

    await startPushService('https://api', 'jwt', 'dev-ios');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as any).body).platform).toBe(
      'ios'
    );
  });

  it('desktop (ni Android ni iOS) est un noop : aucune registration', async () => {
    osPlatformStub.mockReturnValue('windows');
    await startPushService('https://api', 'jwt', 'dev-desktop');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('an iPad whose WebView calls itself Macintosh still registers as ios', async () => {
    // The regression this file could not have caught before: the platform used to come from the user
    // agent, and an iPad WKWebView says "Macintosh" - so an iPad fell through to `null` and the whole
    // service returned as desktop, with no token and no report. `detectRuntimeDeviceOs` answers with
    // the compile-time target inside a Tauri build, so the lying user agent no longer decides.
    osPlatformStub.mockReturnValue('ios');
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    tauriInvokeStub.mockImplementation((cmd: string) => {
      if (cmd === 'get_fcm_token') return Promise.resolve('tok-ipad');
      return Promise.resolve(undefined);
    });

    await startPushService('https://api', 'jwt', 'dev-ipad');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as any).body).platform).toBe(
      'ios'
    );
  });
});
