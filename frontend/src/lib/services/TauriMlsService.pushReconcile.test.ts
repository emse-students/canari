// @vitest-environment happy-dom
// Break the app-wide import cycle the way `MlsService.enrolmentVersion.test.ts` does.
vi.mock('$lib/services/WebMlsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

const { deviceOs, reconcile } = vi.hoisted(() => ({
  deviceOs: vi.fn(() => 'android'),
  reconcile: vi.fn(),
}));
vi.mock('$lib/mls-client/mlsPlatform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectRuntimeDeviceOs: deviceOs,
}));
vi.mock('./PushNotificationService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushOutcomeForReport: () => 'unauthorized',
  reconcilePushRegistration: reconcile,
}));

import { TauriMlsService } from './TauriMlsService';

/**
 * EVERY `register-device` OF A PHONE RE-DRIVES ITS PUSH REGISTRATION FROM THE SERVER'S ANSWER, and
 * states its last outcome. This is the seam that makes a lost or never-written `push_token` row heal
 * at the next unlock instead of never (production 2026-11-15, 25 of 65 `1.6.12` phones).
 */
function ctx(register: ReturnType<typeof vi.fn>) {
  return { userId: 'u1', deviceId: 'd1', delivery: { registerDeviceKeyPackage: register } };
}

const KEY_PACKAGE = { bytes: new Uint8Array([1, 2, 3]), notAfterSecs: 1_800_000_000 };

beforeEach(() => {
  reconcile.mockReset();
  deviceOs.mockReturnValue('android');
});

describe('publishKeyPackage and the push registration', () => {
  it.each(['android', 'ios'])('on %s, states the outcome and acts on the answer', async (os) => {
    deviceOs.mockReturnValue(os);
    const register = vi.fn().mockResolvedValue({ pushRegistered: false });
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register.mock.calls[0][0]).toMatchObject({ deviceOs: os, pushOutcome: 'unauthorized' });
    expect(reconcile).toHaveBeenCalledWith(false);
  });

  it('on a desktop, which registers no push, states nothing and reconciles nothing', async () => {
    deviceOs.mockReturnValue('macos');
    const register = vi.fn().mockResolvedValue({ pushRegistered: false });
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register.mock.calls[0][0]).not.toHaveProperty('pushOutcome');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
