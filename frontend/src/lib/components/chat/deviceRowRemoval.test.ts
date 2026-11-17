import { describe, expect, it, vi } from 'vitest';
import { removeDeviceRow, revocableDeviceId } from './deviceRowRemoval';

describe('removeDeviceRow', () => {
  const row = {
    device: { deviceId: 'web-aaaa-bbbb' },
    unlistedDeviceId: null,
    sessions: [
      { id: 's1', current: false },
      { id: 's2', current: false },
    ],
  };

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
      myDeviceId: 'web-this-one',
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
    await expect(
      removeDeviceRow(
        { device: null, unlistedDeviceId: null, sessions: [{ id: 's9', current: false }] },
        d
      )
    ).resolves.toEqual({
      outcome: 'removed',
      failedSessions: 0,
    });
    expect(d.deleteDevice).not.toHaveBeenCalled();
  });
  /*
   * The cause of the partial restore reported on 2026-08-23, measured on production: the old
   * machine came back under its OWN device id, so nothing had revoked it. Its device had dropped
   * out of the listed devices, the panel showed its login alone, and removing that row only signed
   * it out - the machine kept its whole local store and re-registered under the same id.
   * docs/wiki/frontend/modules/auth.md, "A removed row whose device the server no longer lists".
   */
  it('revokes the device a device-less login still names, then signs that login out', async () => {
    const d = deps('device_deleted');
    await expect(
      removeDeviceRow(
        { device: null, unlistedDeviceId: 'web-old-pc', sessions: [{ id: 's7', current: false }] },
        { ...d, myDeviceId: 'web-this-one' }
      )
    ).resolves.toEqual({ outcome: 'removed', failedSessions: 0 });
    expect(d.calls).toEqual(['device:web-old-pc', 'session:s7']);
  });

  it('never revokes the device it is running on, even when the server does not list it', async () => {
    const d = deps('device_deleted');
    await removeDeviceRow(
      { device: null, unlistedDeviceId: 'web-this-one', sessions: [{ id: 's8', current: false }] },
      { ...d, myDeviceId: 'web-this-one' }
    );
    await removeDeviceRow(
      { device: null, unlistedDeviceId: 'web-stale-id', sessions: [{ id: 's9', current: true }] },
      { ...d, myDeviceId: 'web-this-one' }
    );
    expect(d.deleteDevice).not.toHaveBeenCalled();
    expect(d.calls).toEqual(['session:s8', 'session:s9']);
  });

  it('names the device a row will revoke, so the confirmation can say it is erased', () => {
    const me = 'web-this-one';
    expect(
      revocableDeviceId(
        { device: { deviceId: 'tauri-x' }, unlistedDeviceId: null, sessions: [] },
        me
      )
    ).toBe('tauri-x');
    expect(
      revocableDeviceId({ device: null, unlistedDeviceId: 'web-old-pc', sessions: [] }, me)
    ).toBe('web-old-pc');
    expect(
      revocableDeviceId(
        { device: null, unlistedDeviceId: null, sessions: [{ id: 's', current: false }] },
        me
      )
    ).toBeNull();
    expect(revocableDeviceId({ device: null, unlistedDeviceId: me, sessions: [] }, me)).toBeNull();
  });
});
