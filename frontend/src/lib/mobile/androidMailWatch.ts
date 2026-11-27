import { Log } from '$lib/utils/Log';

/**
 * THE PAGE'S SIDE OF ANDROID'S MAIL WATCH SERVICE (docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * The new-mail watcher runs in the page (`mail/mailWatcher.ts`): its TLS is the WASM engine and its
 * socket the app's own (lot 1). A backgrounded Android process loses its network unless it holds a
 * foreground service - measured for calls on the Mi 9T, 2026-10-20 - so while the account's
 * "Notifications de nouveaux mails" switch is on and its mailbox open, `MailWatchService.kt` holds one,
 * with the persistent notification Android requires (the Thunderbird / K-9 model, owner 2026-11-27).
 *
 * The bridge is `window.canariMail` (`MailWatchBridge.kt`, registered by `MainActivity`):
 * - `start(json)` - enter the foreground, `json` the persistent notification's Paraglide text;
 * - `stop(reason)` - leave it;
 * - `notify(json)` - post ONE new-mail notification natively: its tap is a deep link
 *   (`fr.emse.canari://mail/<conversation>`), which the plugin's notifications cannot carry.
 *
 * Outcomes come back as ONE DOM event, {@link NATIVE_MAIL_EVENT}: `started`, `failed` (with a
 * `code`: `off-screen` when Android refused to start it from the background - the next return on
 * screen asks again - or `refused`), and `stopped` (the service left on its own).
 */

/** The DOM event `MailWatchBridge.emit` dispatches. Its twin is `MailWatchBridge.EVENT` in Kotlin. */
export const NATIVE_MAIL_EVENT = 'canari:mail-native';

/** The persistent notification while the service holds the foreground. Mirrors `MailWatchSpec.kt`. */
export interface MailWatchSpec {
  title: string;
  text: string;
}

/** One new-mail notification, as the native builder posts it. Mirrors `MailNotice.kt`. */
export interface AndroidMailNotice {
  /** The message's Zimbra item id: the notification's id under the mail tag, so a repost replaces. */
  itemId: number;
  /** The sender's name or address. */
  title: string;
  /** The subject. */
  body: string;
  /** What the lock screen shows when the reader hides sensitive content (the OS setting). */
  publicTitle: string;
  /** The app link a tap opens: `fr.emse.canari://mail/<conversation>`. */
  link: string;
}

/** What `MainActivity` registers as `window.canariMail`. */
interface CanariMailBridge {
  start(json: string): void;
  stop(reason: string): void;
  notify(json: string): void;
}

/** The bridge, or `null` off Android (or in a build that registers none). */
export function androidMailBridge(): CanariMailBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { canariMail?: CanariMailBridge }).canariMail;
  return bridge ?? null;
}

/** Asks the service to hold the foreground. `false` when there is no bridge (said at error level). */
export function startAndroidMailService(spec: MailWatchSpec): boolean {
  const bridge = androidMailBridge();
  if (!bridge) {
    Log.w(
      'MAIL-WATCH',
      'ERROR: no window.canariMail on Android - the watch cannot survive the background'
    );
    return false;
  }
  Log.i('MAIL-WATCH', 'asking the mail watch service to start');
  bridge.start(JSON.stringify(spec));
  return true;
}

/** Asks the service to leave the foreground. Idempotent on the native side. */
export function stopAndroidMailService(reason: string): void {
  const bridge = androidMailBridge();
  if (!bridge) return;
  Log.i('MAIL-WATCH', `asking the mail watch service to stop (${reason})`);
  bridge.stop(reason);
}

/** Posts one notice natively. `false` when there is no bridge. */
export function postAndroidMailNotice(notice: AndroidMailNotice): boolean {
  const bridge = androidMailBridge();
  if (!bridge) {
    Log.w('MAIL-WATCH', `ERROR: no window.canariMail - item ${notice.itemId} not notified`);
    return false;
  }
  bridge.notify(JSON.stringify(notice));
  return true;
}
