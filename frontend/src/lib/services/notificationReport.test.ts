// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  markPermissionPromptShown,
  NOTIFICATION_STATE_EVENT,
  notificationStateForReport,
  resetNotificationStateWatchForTest,
  watchNotificationState,
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
  shouldShowRationale: false,
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
      notificationStateForReport(
        {
          ...ANDROID,
          postNotificationsGranted: false,
          notificationsEnabled: false,
        },
        true
      )
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

describe('Android: never asked is told from refused', () => {
  const denied = { ...ANDROID, postNotificationsGranted: false, notificationsEnabled: false };

  it('denied before any prompt is not-determined, never denied', () => {
    expect(notificationStateForReport(denied, false)?.permission).toBe('not-determined');
  });

  it('denied after the dialog was shown (the durable flag) is denied', () => {
    expect(notificationStateForReport(denied, true)?.permission).toBe('denied');
  });

  it('denied with a system rationale on offer is denied: it only comes after a refusal', () => {
    expect(
      notificationStateForReport({ ...denied, shouldShowRationale: true }, false)?.permission
    ).toBe('denied');
  });

  it('granted stays granted whatever the flag says', () => {
    expect(notificationStateForReport(ANDROID, false)?.permission).toBe('granted');
  });

  it('marking the prompt shown flips the default reading', () => {
    localStorage.clear();
    expect(notificationStateForReport(denied)?.permission).toBe('not-determined');
    markPermissionPromptShown();
    expect(notificationStateForReport(denied)?.permission).toBe('denied');
  });
});

describe('the state is re-reported when it changes, driven by the native event', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invoke.mockReset();
    resetNotificationStateWatchForTest();
  });

  it('sends on a change, not on the state already reported, and not twice for one state', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    watchNotificationState(send, notificationStateForReport(ANDROID, true));
    invoke.mockResolvedValue(ANDROID);
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    expect(send).not.toHaveBeenCalled();

    invoke.mockResolvedValue({ ...ANDROID, notificationsEnabled: false });
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  it('keeps the old state when the send fails, so the next event retries', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    watchNotificationState(send, notificationStateForReport(ANDROID, true));
    invoke.mockResolvedValue({ ...ANDROID, notificationsEnabled: false });
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('says nothing when there is no snapshot', async () => {
    const send = vi.fn();
    watchNotificationState(send);
    invoke.mockResolvedValue(null);
    window.dispatchEvent(new CustomEvent(NOTIFICATION_STATE_EVENT));
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});
