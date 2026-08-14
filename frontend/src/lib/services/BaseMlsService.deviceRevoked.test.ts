// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { DeviceRevokedError } from '$lib/mls-client/mlsDeliveryApi';

/**
 * Guards the recovery from a server-side revocation.
 *
 * Deleting a device denylists its id for good, while `resolveDeviceId` deliberately hands the same
 * id back after a reinstall. The server used to accept that re-registration and then filter the
 * device out of its own list forever - registered, invisible and never invitable, with no error
 * anywhere. It now refuses, and the only cure is to become a new device.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd-revoked',
    delivery: { userId: 'u', deviceId: 'd-revoked' },
    generateDeviceId: vi.fn().mockReturnValue('d-fresh'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteDevice: vi.fn().mockResolvedValue(undefined),
    // Real rotation: the assertions below are about what it does.
    rotateDeviceIdentity: BaseMlsService.prototype['rotateDeviceIdentity'],
    ...overrides,
  };
}

const generateKeyPackage = (ctx: unknown): Promise<Uint8Array> =>
  (
    BaseMlsService.prototype as unknown as {
      generateKeyPackage(k: string): Promise<Uint8Array>;
    }
  ).generateKeyPackage.call(ctx, 'key-b64');

describe('BaseMlsService.generateKeyPackage on a revoked device', () => {
  beforeEach(() => localStorage.clear());

  it('re-enrols under a fresh id and publishes again', async () => {
    const published = new Uint8Array([9]);
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new DeviceRevokedError('d-revoked'))
      .mockResolvedValueOnce(published);
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).resolves.toBe(published);

    expect(ctx.deviceId).toBe('d-fresh');
    expect(ctx.delivery.deviceId).toBe('d-fresh');
    // Persisted before anything else may fail: a new id in localStorage next to the old state is
    // what made the identity churn self-sustaining.
    expect(localStorage.getItem('mls_device_id_u')).toBe('d-fresh');
    expect(ctx.persistCheckpoint).toHaveBeenCalledWith('key-b64');
    expect(ctx.deleteDevice).toHaveBeenCalledWith('u', 'd-revoked');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once - a second refusal is a server bug, not a rotation loop', async () => {
    const impl = vi.fn().mockRejectedValue(new DeviceRevokedError('d-revoked'));
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('leaves any other failure alone, identity untouched', async () => {
    const impl = vi.fn().mockRejectedValue(new Error('network down'));
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).rejects.toThrow('network down');
    expect(ctx.deviceId).toBe('d-revoked');
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
