/**
 * Takes the push-banner tap the iOS notification delegate left for the page.
 *
 * iOS hands a tap to `CanariNotificationDelegate` (`canari_push.mm`) - from a KILLED app before the
 * WebView exists, from a backgrounded one before the page has resumed. So the native side writes the
 * tap's link into `pending_notification_tap.json` (durable state) and this module takes it - read
 * and deleted in one command, `read_and_clear_pending_notification_tap`, so a tap is acted on
 * exactly once - and hands the link to the deep-link router (`hooks.client.ts`).
 *
 * NO CLOCK DECIDES WHEN. The page takes the file once its router is mounted, and whenever the native side
 * dispatches {@link NATIVE_NOTIFICATION_TAP_EVENT}. The native side writes the file BEFORE it
 * dispatches, and {@link listenForNativeNotificationTaps} registers its listener BEFORE its first
 * take: either the listener hears the event, or the event came first and the take finds the file.
 * See `docs/wiki/frontend/mobile.md` ("One notification delegate").
 */
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { routerReady } from '$lib/navigation/routerReady';
import { describeDeepLink } from '$lib/utils/logSanitize';

/** The event the native side dispatches when a tap waits in the file. */
export const NATIVE_NOTIFICATION_TAP_EVENT = 'canari:notification-tap';

/** The Tauri command that takes the file. */
export const TAKE_NOTIFICATION_TAP_COMMAND = 'read_and_clear_pending_notification_tap';

/**
 * The link a native tap record names, or null (said) when the record is not one: not JSON, no
 * `deepLink`, or a link of another scheme - the native side writes only this app's links
 * (`CanariTapDeepLink`), so anything else is a defect there, never a route.
 */
export function parseNativeNotificationTap(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[NotifTap] the native tap record is not JSON - dropped: ${String(e)}`);
    return null;
  }
  const link =
    parsed && typeof parsed === 'object' ? (parsed as { deepLink?: unknown }).deepLink : undefined;
  if (typeof link !== 'string' || !link) {
    console.error('[NotifTap] the native tap record names no link - dropped');
    return null;
  }
  if (!link.startsWith(`${MOBILE_APP_PROTOCOL}//`)) {
    console.error(
      `[NotifTap] the native tap record names a link of another scheme - dropped: ${describeDeepLink(link)}`
    );
    return null;
  }
  return link;
}

/** What takes the file: the Tauri command, injected so a test can stand in for it. */
export type TakeNotificationTap = () => Promise<string | null>;

async function invokeTake(): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>(TAKE_NOTIFICATION_TAP_COMMAND);
}

/**
 * Takes a waiting tap, if any, and returns its link. Null when nothing waits or the record is not
 * one; a failed command is said and answers null (the file stays for the next take).
 */
export async function takeNativeNotificationTap(
  take: TakeNotificationTap = invokeTake
): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await take();
  } catch (e) {
    console.error(`[NotifTap] the native tap could not be taken: ${String(e)}`);
    return null;
  }
  if (!raw) return null;
  const link = parseNativeNotificationTap(raw);
  if (link) console.log(`[NotifTap] native tap taken: ${describeDeepLink(link)}`);
  return link;
}

/**
 * Hands every native tap to `open`: registers the event listener FIRST, then takes once for a tap
 * that came before this page (a cold start). Returns the unsubscribe. A repeated event is harmless:
 * the take empties the file, so a second one reads nothing.
 *
 * NOTHING IS TAKEN BEFORE `ready` RESOLVES (the router exists, {@link routerReady}). The take
 * DELETES the file, and a page link's `goto` before the router exists no-ops: a cold-start tap on a
 * post, a form or the agenda was read, dropped, and gone (review of #2843, F4). Waiting keeps ONE
 * path - every link, chat or page, is routed by a mounted router.
 */
export function listenForNativeNotificationTaps(
  open: (link: string) => void,
  take: TakeNotificationTap = invokeTake,
  ready: Promise<void> = routerReady
): () => void {
  const drain = () => {
    void ready
      .then(() => takeNativeNotificationTap(take))
      .then((link) => {
        if (link) open(link);
      });
  };
  window.addEventListener(NATIVE_NOTIFICATION_TAP_EVENT, drain);
  drain();
  return () => window.removeEventListener(NATIVE_NOTIFICATION_TAP_EVENT, drain);
}
