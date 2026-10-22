import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DeviceTrustRefusedError } from './deviceTrust';
import { isRefusedDevice, recordRefusedDevice } from './refusedDevices';

const own = { userId: 'me', deviceId: 'my-dev' };

describe('refusedDevices', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('remembers a changed key, reading the user half case-insensitively', () => {
    expect(
      recordRefusedDevice(own, new DeviceTrustRefusedError('signature-key-changed', 'Peer', 'd1'))
    ).toBe(true);
    expect(isRefusedDevice(own, 'peer', 'd1')).toBe(true);
    expect(isRefusedDevice(own, 'peer', 'D1')).toBe(false);
  });

  it('does not remember an identity mismatch - the next package may be the right one', () => {
    expect(
      recordRefusedDevice(own, new DeviceTrustRefusedError('identity-mismatch', 'peer', 'd1'))
    ).toBe(false);
    expect(isRefusedDevice(own, 'peer', 'd1')).toBe(false);
  });

  it('belongs to this device: a new own id (whose pins start over) refuses nothing', () => {
    recordRefusedDevice(own, new DeviceTrustRefusedError('signature-key-changed', 'peer', 'd1'));
    expect(isRefusedDevice({ userId: 'me', deviceId: 'my-new-dev' }, 'peer', 'd1')).toBe(false);
  });
});
