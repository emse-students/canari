import { describe, expect, it, vi } from 'vitest';
import {
  DeviceTrustRefusedError,
  deviceEventAudience,
  deviceEventKey,
  reportDeviceTrustRefusal,
  resetReportedDeviceTrustRefusals,
  type DeviceEvent,
} from './deviceTrust';

const event = (over: Partial<DeviceEvent> = {}): DeviceEvent => ({
  groupId: 'g1',
  epoch: 4,
  identity: 'bob:web-2',
  keyFingerprint: '0011223344556677',
  trust: 'first-sight',
  addedBy: 'bob:phone-1',
  ...over,
});

// Decided by the user 2026-10-22: the owner is alerted wherever the admission happened; contacts see
// "X added a device" in private conversations only, never in a community or salon key group.
describe('deviceEventAudience - who is told about an admitted device', () => {
  it('shows the contact line in a 1:1 or group conversation', () => {
    expect(
      deviceEventAudience(event(), { ownUserId: 'alice', isKeyDistributionGroup: false })
    ).toBe('contact-line');
  });

  it('shows nothing to contacts in a community key group', () => {
    expect(deviceEventAudience(event(), { ownUserId: 'alice', isKeyDistributionGroup: true })).toBe(
      'none'
    );
  });

  it('alerts the account owner from any kind of group, case-insensitively', () => {
    for (const isKeyDistributionGroup of [false, true]) {
      expect(
        deviceEventAudience(event({ identity: 'BOB:web-2' }), {
          ownUserId: 'bob',
          isKeyDistributionGroup,
        })
      ).toBe('owner-alert');
    }
  });

  it('announces nothing for a changed key found in a joined tree, which no commit admitted', () => {
    expect(
      deviceEventAudience(event({ trust: 'key-changed', addedBy: null }), {
        ownUserId: 'bob',
        isKeyDistributionGroup: false,
      })
    ).toBe('none');
  });
});

describe('deviceEventKey - one device under one key is announced once', () => {
  it('is the same across groups and user-id case, and differs by device and by key', () => {
    const base = deviceEventKey(event());
    expect(deviceEventKey(event({ groupId: 'g2', identity: 'BOB:web-2' }))).toBe(base);
    expect(deviceEventKey(event({ identity: 'bob:WEB-2' }))).not.toBe(base);
    expect(deviceEventKey(event({ keyFingerprint: 'ffffffffffffffff' }))).not.toBe(base);
  });
});

describe('reportDeviceTrustRefusal', () => {
  it('says a refusal once at error, then at debug', () => {
    resetReportedDeviceTrustRefusals();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const refusal = new DeviceTrustRefusedError('signature-key-changed', 'bob', 'web-2');

    expect(reportDeviceTrustRefusal('[T]', 'g1', refusal)).toBe(true);
    expect(reportDeviceTrustRefusal('[T]', 'g2', refusal)).toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(1);
    error.mockRestore();
    debug.mockRestore();
  });
});
