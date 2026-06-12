import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ token: 'tok-123' as string | null }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === 'get_fcm_token' ? Promise.resolve(h.token) : Promise.resolve(undefined)
  ),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));

import { startPushService } from './PushNotificationService';

describe('startPushService - rotation de token FCM', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    h.token = 'tok-123';
    sessionStorage.clear();
    Object.defineProperty(navigator, 'userAgent', { value: 'android', configurable: true });
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pushSecret: 'secret' }),
      text: async () => '',
    });
    globalThis.fetch = fetchMock as any;
  });

  it('1er appel enregistre, ré-appel inchangé skip, ré-appel après rotation ré-enregistre', async () => {
    // 1er appel : enregistrement complet.
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Ré-appel (retour premier plan) sans changement de token → pas de re-POST.
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Le token FCM tourne (onNewToken a écrit le nouveau localement) → ré-appel ré-enregistre.
    h.token = 'tok-456';
    await startPushService('https://api', 'jwt', 'dev-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(lastBody.token).toBe('tok-456');
  });
});
