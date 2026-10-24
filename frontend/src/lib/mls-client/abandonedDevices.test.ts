// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readAbandonedDeviceIds,
  recordAbandonedDevice,
  retireAbandonedDevices,
} from './abandonedDevices';

const USER = 'u';

describe('abandonedDevices - an abandoned id is retired exactly once', () => {
  beforeEach(() => localStorage.clear());

  it('keeps an id whose delete failed, and retires it at the next round', async () => {
    recordAbandonedDevice(USER, 'old');
    const deleteDevice = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error' })
      .mockResolvedValueOnce({ status: 'deleted' });
    const target = { userId: USER, liveDeviceId: 'new', deleteDevice };

    await retireAbandonedDevices(target);
    expect(readAbandonedDeviceIds(USER)).toEqual(['old']);

    await retireAbandonedDevices(target);
    expect(readAbandonedDeviceIds(USER)).toEqual([]);

    await retireAbandonedDevices(target);
    expect(deleteDevice).toHaveBeenCalledTimes(2);
  });

  it('shares one flight between simultaneous callers', async () => {
    recordAbandonedDevice(USER, 'old');
    const deleteDevice = vi.fn().mockResolvedValue({ status: 'deleted' });
    const target = { userId: USER, liveDeviceId: 'new', deleteDevice };

    await Promise.all([retireAbandonedDevices(target), retireAbandonedDevices(target)]);

    expect(deleteDevice).toHaveBeenCalledTimes(1);
  });

  // AN ALLOWLIST: the live id is never deleted, whatever the record says.
  it('drops the live id from the record and never deletes it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordAbandonedDevice(USER, 'live');
    const deleteDevice = vi.fn();

    await retireAbandonedDevices({ userId: USER, liveDeviceId: 'live', deleteDevice });

    expect(deleteDevice).not.toHaveBeenCalled();
    expect(readAbandonedDeviceIds(USER)).toEqual([]);
    error.mockRestore();
  });

  it('retires nothing from an unreadable record', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(`mls_retiring_device_ids_${USER}`, '{not json');
    const deleteDevice = vi.fn();

    await retireAbandonedDevices({ userId: USER, liveDeviceId: 'new', deleteDevice });

    expect(deleteDevice).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
