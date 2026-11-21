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
  shouldShowRationale: boolean;
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

/** The page's durable "the OS permission dialog was shown on this install" flag. */
const PROMPT_SHOWN_KEY = 'canari.notificationPromptShown';

/** Records that the OS permission dialog was opened - called once `requestPermission` answers. */
export function markPermissionPromptShown(): void {
  try {
    localStorage.setItem(PROMPT_SHOWN_KEY, '1');
  } catch (err) {
    console.warn('[Push] could not record that the permission prompt was shown', err);
  }
}

/** Whether the OS permission dialog was ever opened on this install; false when unreadable. */
function permissionPromptShown(): boolean {
  try {
    return localStorage.getItem(PROMPT_SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The wire report of a snapshot - a pure mapping, so the two platforms' meaning is pinned in one place.
 *
 * ANDROID, `permission`: `granted` when POST_NOTIFICATIONS is granted; else `denied` once the dialog
 * was shown (`promptShown`, the page's durable flag) or the system offers a rationale (it only does
 * after a refusal); else `not-determined`, because `checkSelfPermission` says DENIED before the first
 * prompt too. A phone refused before the flag existed and out of rationales reads `not-determined`
 * (the server counts it `not-asked`, off all the same).
 */
export function notificationStateForReport(
  state: NotificationDeliveryState | null,
  promptShown: boolean = permissionPromptShown()
): NotificationStateReport | undefined {
  if (!state) return undefined;
  if (state.platform === 'android') {
    const refused = promptShown || state.shouldShowRationale;
    return {
      permission: state.postNotificationsGranted
        ? 'granted'
        : refused
          ? 'denied'
          : 'not-determined',
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

/** The page's event after the native side wrote a fresh snapshot (launch, foreground, a dialog closing). */
export const NOTIFICATION_STATE_EVENT = 'canari:notification-state';

let lastReported: string | null = null;
let removeWatch: (() => void) | null = null;

/**
 * Sends the state to the server WHEN IT CHANGES - the daily count would otherwise read, until the
 * next unlock, a state the user already changed (first launch `not-asked`, then granted). Driven by
 * the native event that follows a fresh snapshot, never a timer. `seed` is what `register-device`
 * just sent, so the first event does not repeat it. A failed send is logged and left: the next event
 * or the next `register-device` carries the state again.
 */
export function watchNotificationState(
  send: (report: NotificationStateReport) => Promise<void>,
  seed?: NotificationStateReport
): void {
  if (seed) lastReported = JSON.stringify(seed);
  if (removeWatch || typeof window === 'undefined') return;
  const onEvent = () => {
    void (async () => {
      const report = await notificationStateReport();
      if (!report) return;
      const key = JSON.stringify(report);
      if (key === lastReported) return;
      try {
        await send(report);
        lastReported = key;
        console.info('[Push] notification state changed - reported', report.permission);
      } catch (err) {
        console.warn('[Push] notification state change not reported - the next event retries', err);
      }
    })();
  };
  window.addEventListener(NOTIFICATION_STATE_EVENT, onEvent);
  removeWatch = () => window.removeEventListener(NOTIFICATION_STATE_EVENT, onEvent);
}

/** Test seam: forgets the watcher's memory. */
export function resetNotificationStateWatchForTest(): void {
  lastReported = null;
  removeWatch?.();
  removeWatch = null;
}
