// Stub Tauri internals before any import so the CJS module picks them up.
// Vitest v4 ne supporte pas vi.mock pour les modules CJS comme @tauri-apps/api/core.
// On stubbe donc l'objet global que le module CJS utilise en interne.
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
    Object.defineProperty(navigator, 'userAgent', { value: 'android', configurable: true });

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

    // Ré-appel (retour premier plan) sans changement de token → pas de re-POST.
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Le token FCM tourne (onNewToken a écrit le nouveau localement) → ré-appel ré-enregistre.
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
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });

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
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    await startPushService('https://api', 'jwt', 'dev-desktop');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
