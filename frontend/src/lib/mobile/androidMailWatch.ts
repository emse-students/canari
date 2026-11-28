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
 * The bridge is `window.canariMail` (`MailWatchBridge.kt`), a WEB MESSAGE LISTENER rather than a
 * JavaScript interface: Android delivers a message only from the app's own origin in the TOP frame,
 * so no frame inside the page (a mail's sandbox) can drive it. Each message is one JSON `op`:
 * - `start` - enter the foreground, with the persistent notification's Paraglide text;
 * - `stop` - leave it (always sent: the native side ignores a stop with nothing held);
 * - `notify` - post ONE new-mail notification natively: its tap is a deep link
 *   (`fr.emse.canari://mail/<conversation>`), which the plugin's notifications cannot carry;
 * - `summary` - post the ONE notice that stands for a flood of new mails;
 * - `page` - a new document: the page before it is gone (lot 4b: the watch goes native if armed);
 * - `claim` - the page's watcher is about to run: the native run stops, JOINED, then `handed`
 *   carrying the claim's own id;
 * - `arm` - seal the password for the native watcher (lot 4b): sent only with "remember" ticked AND
 *   the switch on;
 * - `forget` - EVERY forget path: the sealed copy erased AND every native run stopped and joined, as
 *   one native op (`NativeMailWatcher.forget`) - sent whatever the page believes is running;
 * - `release` - the page's watcher stopped: a push check may read the delta again.
 *
 * Outcomes come back as ONE DOM event, {@link NATIVE_MAIL_EVENT}: `started` (`code` the mode, `page`
 * or `native`), `failed` (with a `code`: `off-screen` when Android refused to start it from the
 * background - the next return on screen asks again - or `refused`), `stopped` (the service left on
 * its own), `handed` and `armed` (`ok` / `failed`).
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

/** One new-mail summary (more than `MAX_SINGLE_NOTICES` at once). Mirrors `MailSummary.kt`. */
export interface AndroidMailSummary {
  count: number;
  title: string;
  body: string;
  publicTitle: string;
  link: string;
}

/** What `MainActivity` registers as `window.canariMail`: a web message port, one JSON op each. */
interface CanariMailBridge {
  postMessage(message: string): void;
}

/** The bridge, or `null` off Android (or in a build that registers none). */
export function androidMailBridge(): CanariMailBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { canariMail?: CanariMailBridge }).canariMail;
  return bridge && typeof bridge.postMessage === 'function' ? bridge : null;
}

/** Sends one op; `false` when there is no bridge. */
function send(op: string, payload: Record<string, unknown>): boolean {
  const bridge = androidMailBridge();
  if (!bridge) return false;
  bridge.postMessage(JSON.stringify({ op, ...payload }));
  return true;
}

/** Asks the service to hold the foreground. `false` when there is no bridge (said at error level). */
export function startAndroidMailService(spec: MailWatchSpec): boolean {
  Log.i('MAIL-WATCH', 'asking the mail watch service to start');
  if (send('start', { title: spec.title, text: spec.text })) return true;
  Log.w(
    'MAIL-WATCH',
    'ERROR: no window.canariMail on Android - the watch cannot survive the background'
  );
  return false;
}

/** Asks the service to leave the foreground. ALWAYS sent; idempotent on the native side. */
export function stopAndroidMailService(reason: string): void {
  Log.i('MAIL-WATCH', `asking the mail watch service to stop (${reason})`);
  if (!send('stop', { reason })) Log.d('MAIL-WATCH', 'no window.canariMail - nothing to stop');
}

/** A new document: the page before it is gone - the native side hands an armed watch to native. */
export function announceAndroidPageReplaced(): void {
  if (send('page', {})) Log.d('MAIL-WATCH', 'told the service a new document starts');
}

let lastClaimId = 0;

/**
 * The page's watcher is about to run: resolves once the native run is STOPPED AND JOINED - the
 * `handed` answer to THIS claim (its id: an earlier claim's answer resolves nothing) - so the two
 * never write the cursor or notify at once. Resolves at once with no bridge (nothing native can run
 * then); REJECTS when the claim could not be sent (the caller must not start a second writer). The
 * native side always answers a claim it received: no timer here.
 */
export function claimAndroidMailWatch(): Promise<void> {
  if (typeof window === 'undefined' || !androidMailBridge()) return Promise.resolve();
  const id = `claim-${++lastClaimId}`;
  return new Promise((resolveIt, rejectIt) => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; code?: string }>).detail;
      if (detail?.kind !== 'handed' || detail.code !== id) return;
      window.removeEventListener(NATIVE_MAIL_EVENT, onEvent);
      Log.d('MAIL-WATCH', 'the native watch is handed to the page');
      resolveIt();
    };
    window.addEventListener(NATIVE_MAIL_EVENT, onEvent);
    try {
      send('claim', { id });
    } catch (err) {
      window.removeEventListener(NATIVE_MAIL_EVENT, onEvent);
      rejectIt(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Seals `password` for the native watcher (lot 4b). Never logged. `false` with no bridge.
 * `persistent` is the user's persistent-watch choice ("Connexion permanente", mail lot 5): only with
 * it on does the native watch resume at boot and after a kill; off, the copy serves the push check.
 */
export function armAndroidMailWatch(
  userId: string,
  account: string,
  password: string,
  persistent = true
): boolean {
  if (send('arm', { userId, account, password, persistent })) {
    Log.i('MAIL-WATCH', 'the native watcher is armed with the remembered password');
    return true;
  }
  Log.w('MAIL-WATCH', 'ERROR: no window.canariMail - the native watcher cannot be armed');
  return false;
}

/**
 * Forgets the native watcher's sealed copy: erased AND every native run stopped and joined, in ONE
 * native op ordered after any `arm` sent before it. ALWAYS sent when there is a bridge - the page
 * cannot know whether a native run is going (review B1 of #4213).
 */
export function forgetAndroidMailWatch(userId: string): void {
  if (send('forget', { userId })) Log.i('MAIL-WATCH', 'the native watcher is told to forget');
}

/** The page's watcher stopped: the native side may let a push check read the delta again. */
export function releaseAndroidMailWatch(): void {
  if (send('release', {})) Log.d('MAIL-WATCH', 'the page let the watch go');
}

/** Posts one notice natively. `false` when there is no bridge. */
export function postAndroidMailNotice(notice: AndroidMailNotice): boolean {
  if (send('notify', { ...notice })) return true;
  Log.w('MAIL-WATCH', `ERROR: no window.canariMail - item ${notice.itemId} not notified`);
  return false;
}

/** Posts the summary of a flood natively. `false` when there is no bridge. */
export function postAndroidMailSummary(summary: AndroidMailSummary): boolean {
  if (send('summary', { ...summary })) return true;
  Log.w(
    'MAIL-WATCH',
    `ERROR: no window.canariMail - the summary of ${summary.count} mails not posted`
  );
  return false;
}
