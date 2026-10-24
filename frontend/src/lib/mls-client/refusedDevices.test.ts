// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DeviceTrustRefusedError, type DevicePin } from './deviceTrust';
import {
  forgetRefusedDevicesOf,
  isRefusedDevice,
  listRefusedDevices,
  recordRefusedDevice,
  setRefusedDeviceListener,
} from './refusedDevices';

const own = { userId: 'me', deviceId: 'my-dev' };
const pin = (reaffirmations: number): DevicePin => ({
  keys: [new Uint8Array([1])],
  anchored: true,
  reaffirmations,
});
const mlsWith = (current: DevicePin | null) => ({
  pinnedSignatureKeys: vi.fn().mockResolvedValue(current),
});
const changedKey = (u = 'peer', d = 'd1') =>
  new DeviceTrustRefusedError('signature-key-changed', u, d);

describe('refusedDevices', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('remembers a changed key, reading the user half case-insensitively', async () => {
    const mls = mlsWith(pin(2));
    expect(await recordRefusedDevice(own, changedKey('Peer'), mls)).toBe(true);
    expect(await isRefusedDevice(own, 'peer', 'd1', mls)).toBe(true);
    expect(await isRefusedDevice(own, 'peer', 'D1', mls)).toBe(false);
  });

  it('does not remember an identity mismatch - the next package may be the right one', async () => {
    const mls = mlsWith(pin(0));
    expect(
      await recordRefusedDevice(
        own,
        new DeviceTrustRefusedError('identity-mismatch', 'peer', 'd1'),
        mls
      )
    ).toBe(false);
    expect(await isRefusedDevice(own, 'peer', 'd1', mls)).toBe(false);
  });

  // ONE FORGED PACKAGE LOOKS LIKE A KEY CHANGE: the refusal is lifted by the fact that disproves it.
  it('lifts the refusal once a merged commit showed the device holding its pinned key', async () => {
    await recordRefusedDevice(own, changedKey(), mlsWith(pin(2)));
    expect(await isRefusedDevice(own, 'peer', 'd1', mlsWith(pin(2)))).toBe(true);
    expect(await isRefusedDevice(own, 'peer', 'd1', mlsWith(pin(3)))).toBe(false);
    expect(
      await isRefusedDevice(own, 'peer', 'd1', mlsWith(pin(2))),
      'lifted for good, not re-derived'
    ).toBe(false);
  });

  it('lifts the refusal once the pin it was judged by is gone', async () => {
    await recordRefusedDevice(own, changedKey(), mlsWith(pin(0)));
    expect(await isRefusedDevice(own, 'peer', 'd1', mlsWith(null))).toBe(false);
  });

  it('belongs to this device, and a rotation drops what the old id kept', async () => {
    const mls = mlsWith(pin(0));
    await recordRefusedDevice(own, changedKey(), mls);
    expect(await isRefusedDevice({ userId: 'me', deviceId: 'my-new-dev' }, 'peer', 'd1', mls)).toBe(
      false
    );
    forgetRefusedDevicesOf(own);
    expect(localStorage.length).toBe(0);
  });

  it('tells its listener of a recorded refusal only, and lists what it remembers', async () => {
    const listener = vi.fn();
    const mls = mlsWith(pin(0));
    setRefusedDeviceListener(listener);
    try {
      await recordRefusedDevice(
        own,
        new DeviceTrustRefusedError('identity-mismatch', 'peer', 'd0'),
        mls
      );
      await recordRefusedDevice(own, changedKey('Me', 'old'), mls);
      await recordRefusedDevice(own, changedKey('peer', 'unpinned'), mlsWith(null));
      expect(listener.mock.calls).toEqual([['me:old']]);
      expect(listRefusedDevices(own)).toEqual(['me:old']);
    } finally {
      setRefusedDeviceListener(null);
    }
  });

  it('stops listing a refusal once it is lifted', async () => {
    await recordRefusedDevice(own, changedKey(), mlsWith(pin(1)));
    expect(listRefusedDevices(own)).toEqual(['peer:d1']);
    await isRefusedDevice(own, 'peer', 'd1', mlsWith(pin(2)));
    expect(listRefusedDevices(own)).toEqual([]);
  });

  it('a throwing listener does not undo the refusal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mls = mlsWith(pin(0));
    setRefusedDeviceListener(() => {
      throw new Error('ui');
    });
    try {
      expect(await recordRefusedDevice(own, changedKey(), mls)).toBe(true);
      expect(await isRefusedDevice(own, 'peer', 'd1', mls)).toBe(true);
      expect(error).toHaveBeenCalled();
    } finally {
      setRefusedDeviceListener(null);
    }
  });
});
