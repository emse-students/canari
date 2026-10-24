// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));
vi.mock('$lib/utils/openExternal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/openExternal')>()),
  isTauriRuntime: () => true,
}));

import { TauriMlsService } from './TauriMlsService';
import { DELETE_DEVICE_KEY_COMMAND } from './keystoreCommands';

/**
 * A KEYSTORE THAT REFUSES THE NEW KEY MUST NOT KEEP THE OLD ONE. A refusal raised before the native
 * side's own deletes (a malformed key, a platform that throws first) left the old key in place, and
 * with biometric unlock on that is a silent login on the old PIN, past the server check.
 */
interface Internals {
  userId: string;
  deviceId: string;
  pointUnattendedUnlockAt(k: string): Promise<boolean>;
}

function service(): Internals {
  const svc = new TauriMlsService() as unknown as Internals;
  svc.userId = 'user-1';
  svc.deviceId = 'device-1';
  return svc;
}

describe('TauriMlsService.pointUnattendedUnlockAt - a refused write', () => {
  beforeEach(() => invoke.mockReset());

  it('deletes the keystore entry, then propagates the refusal', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'actualiser_cle_keystore_avec_devicekey') throw new Error('status -25293');
    });

    await expect(service().pointUnattendedUnlockAt('a2V5')).rejects.toThrow('-25293');

    expect(invoke).toHaveBeenCalledWith(DELETE_DEVICE_KEY_COMMAND, {
      alias: 'mls_device_key_user-1_device-1',
    });
  });

  it('deletes nothing when the write lands', async () => {
    invoke.mockResolvedValue(undefined);

    await expect(service().pointUnattendedUnlockAt('a2V5')).resolves.toBe(true);

    expect(invoke).not.toHaveBeenCalledWith(DELETE_DEVICE_KEY_COMMAND, expect.anything());
  });
});
