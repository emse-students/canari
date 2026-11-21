import { invoke } from '@tauri-apps/api/core';

/**
 * WHAT THE OS LETS THIS INSTALL'S NOTIFICATIONS DO - read through ONE typed command, reported to the
 * server and nothing else (owner, 2026-11-21: no banner, no prompt, in this change).
 *
 * `notification_delivery_state` (`src-tauri/src/commands/notification_delivery_state.rs`, which pins
 * the shape) answers a snapshot the native side rewrites at every launch and return to the
 * foreground. It READS: it never asks the OS for anything. `null` is UNKNOWN - no snapshot yet, an
 * unreadable one, or a platform with no push - and unknown is never reported as granted.
 */

/** The importance of a channel by name, as `NotificationDeliveryState.kt` writes it. */
type ChannelImportance = 'none' | 'min' | 'low' | 'default' | 'high' | 'unspecified' | 'absent';

/** `UNNotificationSetting` by name. */
type IosSetting = 'enabled' | 'disabled' | 'not-supported';

/** The command's answer on Android - the keys are the snapshot's. */
export interface AndroidDeliveryState {
  platform: 'android';
  notificationsEnabled: boolean;
  postNotificationsGranted: boolean;
  channels: { messages: ChannelImportance; posts: ChannelImportance };
  isIgnoringBatteryOptimizations: boolean;
  manufacturer: string;
}

/** The command's answer on iOS - the keys are the snapshot's. */
export interface IosDeliveryState {
  platform: 'ios';
  authorization: 'not-determined' | 'denied' | 'granted' | 'provisional' | 'ephemeral';
  alert: IosSetting;
  sound: IosSetting;
  badge: IosSetting;
  timeSensitive: IosSetting;
}

/** What `notification_delivery_state` answers. */
export type NotificationDeliveryState = AndroidDeliveryState | IosDeliveryState;

/** The `notificationState` of `register-device` - the server's `parseNotificationState` input. */
export interface NotificationStateReport {
  permission: 'granted' | 'denied' | 'not-determined' | 'provisional' | 'ephemeral';
  /** Whether the OS lets the app show a notification at all. */
  enabled: boolean;
  /** iOS: the alert setting is on. Absent on Android. */
  alerts?: boolean;
  /** Android: the importance of the messages and posts channels. Absent on iOS. */
  channels?: { messages: ChannelImportance; posts: ChannelImportance };
}

/** Reads the snapshot; `null` (logged) when the command fails or the OS has no answer yet. */
export async function readNotificationDeliveryState(): Promise<NotificationDeliveryState | null> {
  try {
    const state = await invoke<NotificationDeliveryState | null>('notification_delivery_state');
    if (!state) console.info('[Push] notification_delivery_state: no snapshot - state unknown');
    return state ?? null;
  } catch (err) {
    console.warn('[Push] notification_delivery_state failed - state unknown', err);
    return null;
  }
}

/** The wire report of a snapshot - a pure mapping, so the two platforms' meaning is pinned in one place. */
export function notificationStateForReport(
  state: NotificationDeliveryState | null
): NotificationStateReport | undefined {
  if (!state) return undefined;
  if (state.platform === 'android') {
    return {
      permission: state.postNotificationsGranted ? 'granted' : 'denied',
      enabled: state.notificationsEnabled,
      channels: { ...state.channels },
    };
  }
  const permitted = ['granted', 'provisional', 'ephemeral'].includes(state.authorization);
  return {
    permission: state.authorization,
    enabled: permitted,
    alerts: state.alert === 'enabled',
  };
}

/** Reads and maps in one step: what `register-device` sends, or `undefined` for unknown. */
export async function notificationStateReport(): Promise<NotificationStateReport | undefined> {
  return notificationStateForReport(await readNotificationDeliveryState());
}
