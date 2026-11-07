import { vi } from 'vitest';
import type { DeviceKeyPackage, DeviceKeyPackageAnswer } from '../../deviceKeyPackage';

/**
 * A `fetchDeviceKeyPackage` mock answering from a fixed set of published devices: the package of a
 * listed device, `unregistered` for any other. The adding paths claim ONE device's package, never
 * the account's list (`docs/wiki/protocols/key-package-pool.md`), so this is what a test of them
 * configures.
 */
export function devicePackages(devices: DeviceKeyPackage[]) {
  return vi.fn(async (_userId: string, deviceId: string): Promise<DeviceKeyPackageAnswer> => {
    const device = devices.find((d) => d.deviceId === deviceId);
    return device ? { kind: 'package', device } : { kind: 'none', reason: 'unregistered' };
  });
}
