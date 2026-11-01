/**
 * WHETHER THE iPHONE APP IS ACTIVE - a dedicated signal for two decisions only: may the page consume
 * a queued frame now, and may it raise a message banner.
 *
 * Out of front on iOS the SERVER is the one announcer: the page consumes no queued frame while
 * inactive, so the row stays queued, the server pushes it, and the notification extension decrypts
 * it FIRST and announces it with its content (docs/wiki/frontend/mobile.md, "out of front, the server
 * announces"). Consuming it here would spend the frame's secret, and the extension, which decrypts
 * read-only from `mls.bin`, would then show a banner with no content.
 *
 * Written by `CanariPushActiveToPage` (canari_ios.mm) from `didBecomeActive` / `willResignActive`
 * and after every page load. NOT `isAppInForeground()` (`appForeground.ts`): ten other iOS consumers
 * read that one with its own meaning, and this change leaves them alone.
 */
import { isIosTauriRuntime } from '$lib/utils/appVersion';

/** The global the iOS bootstrap writes on every active/inactive transition. */
const FLAG = '__canariActive';

/** The event it dispatches at the same moment. */
export const APP_ACTIVE_EVENT = 'canari:active';

/**
 * True when this is the iOS app AND it said it is inactive. False everywhere else - Android, web,
 * desktop, and an iOS page not told yet - so every other runtime keeps today's behaviour.
 *
 * READ, NEVER CACHED, and synchronous: the queue reads it at the instant a frame would start to be
 * decrypted, and the transition arrives as a JS task, so the two can never interleave.
 */
export function isIosAppInactive(): boolean {
  if (typeof window === 'undefined' || !isIosTauriRuntime()) return false;
  return (window as unknown as Record<string, unknown>)[FLAG] === false;
}

/** Calls `onActive` on every transition back to active on iOS. Returns the unsubscribe. */
export function onIosAppActive(onActive: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ active?: unknown }>).detail;
    if (detail?.active === true) onActive();
  };
  window.addEventListener(APP_ACTIVE_EVENT, handler);
  return () => window.removeEventListener(APP_ACTIVE_EVENT, handler);
}
