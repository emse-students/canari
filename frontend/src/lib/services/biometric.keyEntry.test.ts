// @vitest-environment happy-dom
const invoke = vi.fn();
const authenticate = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/plugin-biometric', () => ({
  authenticate: (...args: unknown[]) => authenticate(...args),
  checkStatus: vi.fn(),
  BiometryType: {},
}));

import { BiometricService } from './biometric';
import { DELETE_DEVICE_KEY_COMMAND } from './keystoreCommands';

/**
 * THE KEYSTORE ENTRY IS THE ONLY COPY OF A HARDWARE-HELD KEY, so turning biometrics off must not
 * touch it. The toggle used to delete it and re-store it from the session key, swallowing every
 * failure: a kill between the two lost every local message on a migrated phone.
 */
describe('BiometricService and the keystore entry', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    authenticate.mockReset();
    authenticate.mockResolvedValue(undefined);
  });

  it('turns biometrics off without deleting or rewriting any keystore entry', async () => {
    await BiometricService.disable();

    expect(authenticate).toHaveBeenCalledTimes(1);
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain(DELETE_DEVICE_KEY_COMMAND);
    expect(commands.some((c) => String(c).includes('key_bytes'))).toBe(false);
    expect(commands).not.toContain('actualiser_cle_keystore_avec_devicekey');
  });

  it('changes nothing when the owner cancels the prompt', async () => {
    authenticate.mockRejectedValue(new Error('cancelled'));

    await expect(BiometricService.disable()).rejects.toThrow('cancelled');

    expect(invoke).not.toHaveBeenCalled();
  });

  it('deletes through the guarded app command, never the plugin', async () => {
    await BiometricService.forget('mls_device_key_u1_d1');
    await BiometricService.deleteKeyEntry('mls_device_key_u1_d1');

    expect(invoke).toHaveBeenCalledWith(DELETE_DEVICE_KEY_COMMAND, {
      alias: 'mls_device_key_u1_d1',
    });
    expect(invoke.mock.calls.some((c) => String(c[0]).startsWith('plugin:keystore|delete'))).toBe(
      false
    );
  });

  it('propagates a guard refusal from the account deletion, so the wipe reports a survivor', async () => {
    invoke.mockRejectedValue('refused by the at-rest guard');

    await expect(BiometricService.deleteKeyEntry('mls_device_key_u1_d1')).rejects.toBe(
      'refused by the at-rest guard'
    );
  });
});
