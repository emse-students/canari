import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  notificationStateForReport,
  notificationStateReport,
  readNotificationDeliveryState,
  type AndroidDeliveryState,
  type IosDeliveryState,
} from './notificationReport';

/**
 * THE ONE TYPED DOOR onto the OS notification state, and what `register-device` reports from it.
 * The shape of the command's answer is pinned on the Rust side
 * (`notification_delivery_state.rs`); these fixtures are the same JSON.
 */
const ANDROID: AndroidDeliveryState = {
  platform: 'android',
  notificationsEnabled: true,
  postNotificationsGranted: true,
  channels: { messages: 'high', posts: 'default' },
  isIgnoringBatteryOptimizations: false,
  manufacturer: 'Xiaomi',
};
const IOS: IosDeliveryState = {
  platform: 'ios',
  authorization: 'granted',
  alert: 'enabled',
  sound: 'enabled',
  badge: 'disabled',
  timeSensitive: 'not-supported',
};

describe('notification state', () => {
  beforeEach(() => invoke.mockReset());

  it('reads through the one command, with no argument and so no prompt', async () => {
    invoke.mockResolvedValue(ANDROID);
    expect(await readNotificationDeliveryState()).toEqual(ANDROID);
    expect(invoke).toHaveBeenCalledWith('notification_delivery_state');
  });

  it('answers unknown (null) when there is no snapshot or the command fails', async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await readNotificationDeliveryState()).toBeNull();
    invoke.mockRejectedValueOnce(new Error('no such command'));
    expect(await readNotificationDeliveryState()).toBeNull();
    invoke.mockResolvedValueOnce(null);
    expect(await notificationStateReport()).toBeUndefined();
  });

  it('reports Android as the permission, the app switch and both channels', () => {
    expect(notificationStateForReport(ANDROID)).toEqual({
      permission: 'granted',
      enabled: true,
      channels: { messages: 'high', posts: 'default' },
    });
    expect(
      notificationStateForReport({
        ...ANDROID,
        postNotificationsGranted: false,
        notificationsEnabled: false,
      })
    ).toMatchObject({ permission: 'denied', enabled: false });
  });

  it.each([
    ['granted', true],
    ['provisional', true],
    ['ephemeral', true],
    ['denied', false],
    ['not-determined', false],
  ] as const)('reports iOS authorization %s as enabled=%s', (authorization, enabled) => {
    expect(notificationStateForReport({ ...IOS, authorization })).toEqual({
      permission: authorization,
      enabled,
      alerts: true,
    });
  });

  it('reports iOS alerts off when the alert setting is not enabled', () => {
    expect(notificationStateForReport({ ...IOS, alert: 'disabled' })?.alerts).toBe(false);
  });

  it('reports nothing for no state: unknown is never granted', () => {
    expect(notificationStateForReport(null)).toBeUndefined();
  });
});
