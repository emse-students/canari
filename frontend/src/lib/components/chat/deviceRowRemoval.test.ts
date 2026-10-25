import { describe, expect, it, vi } from 'vitest';
import { removeDeviceRow } from './deviceRowRemoval';

describe('removeDeviceRow', () => {
  const row = { device: { deviceId: 'web-aaaa-bbbb' }, sessions: [{ id: 's1' }, { id: 's2' }] };

  function deps(deviceStatus: string, failing: string[] = []) {
    const calls: string[] = [];
    return {
      calls,
      deleteDevice: vi.fn(async (id: string) => {
        calls.push(`device:${id}`);
        return { status: deviceStatus };
      }),
      revokeSession: vi.fn(async (id: string) => {
        calls.push(`session:${id}`);
        if (failing.includes(id)) throw new Error('refused');
      }),
    };
  }

  it('revokes the device first, then signs every login of the row out', async () => {
    const d = deps('device_deleted');
    await expect(removeDeviceRow(row, d)).resolves.toEqual({
      outcome: 'removed',
      failedSessions: 0,
    });
    expect(d.calls).toEqual(['device:web-aaaa-bbbb', 'session:s1', 'session:s2']);
  });

  it('still signs the logins out when the device revocation answered an error (a 503)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps('error');
    await expect(removeDeviceRow(row, d)).resolves.toEqual({
      outcome: 'device-incomplete',
      failedSessions: 0,
    });
    expect(d.revokeSession).toHaveBeenCalledTimes(2);
  });

  it('reports logins it could not sign out, after trying every one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps('device_deleted', ['s1']);
    await expect(removeDeviceRow(row, d)).resolves.toEqual({
      outcome: 'sessions-left',
      failedSessions: 1,
    });
    expect(d.revokeSession).toHaveBeenCalledWith('s2');
  });

  it('only signs out a login row that has no device', async () => {
    const d = deps('device_deleted');
    await expect(removeDeviceRow({ device: null, sessions: [{ id: 's9' }] }, d)).resolves.toEqual({
      outcome: 'removed',
      failedSessions: 0,
    });
    expect(d.deleteDevice).not.toHaveBeenCalled();
  });
});
