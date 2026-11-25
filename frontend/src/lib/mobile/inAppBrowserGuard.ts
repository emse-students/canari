/**
 * THE CLIENT HALF OF THE META IN-APP BROWSER GATE (owner decision of 2026-11-25,
 * docs/wiki/frontend/leaving-in-app-browsers.md).
 *
 * The server answers every page request from Messenger, Facebook, Instagram or Threads with the
 * shared interstitial (`$lib/server/leaveInAppBrowser`). A document that still reaches such a
 * browser means that answer was skipped, and this guard is then the only thing between the visitor
 * and the app. It is LOAD-BEARING, not decorative, on three paths:
 *
 *  - `@app_shell`, the shell nginx serves while frontend-ssr is down (the server writes nothing);
 *  - dev's Cloudflare cache, which does not key on `User-Agent`: until the owner's bypass rule
 *    exists, a page cached for a real browser is served to an in-app browser for up to 60 s;
 *  - the same cache filled by a link-preview fetch.
 *
 * So reaching it is a fallback that ACCUSES the primary path, and it logs at warn.
 *
 * Captured ONCE PER DOCUMENT, by the root `load` before anything else runs - before the silent
 * refresh, before any redirect to login - so the link offered and the exit taken are the address
 * the visitor was sent, not one the app moved them to.
 */
import {
  detectMetaInAppBrowser,
  exitHref,
  type MetaInAppBrowser,
} from '$lib/leaveInAppBrowser/detect';
import { Log } from '$lib/utils/Log';

/** What the guard holds for the document: the browser met, and the address it was opened on. */
export interface InAppBrowserGuard {
  browser: MetaInAppBrowser;
  href: string;
}

/** `undefined` until the first read of this document; `null` when the browser is not Meta's. */
let captured: InAppBrowserGuard | null | undefined;

/**
 * The guard for this document, or null when the page may run. The first call captures it from the
 * user agent and the current address; every later call returns that same capture.
 */
export function inAppBrowserGuard(): InAppBrowserGuard | null {
  if (captured !== undefined) return captured;
  if (typeof window === 'undefined') return null;
  const browser = detectMetaInAppBrowser(navigator.userAgent);
  if (!browser) {
    captured = null;
    return captured;
  }
  const href = window.location.href;
  captured = { browser, href };
  Log.w(
    'leaveInAppBrowser',
    `the app reached a Meta in-app browser past the server's interstitial: app=${browser.app} ` +
      `os=${browser.os} ios=${browser.iosMajor ?? '-'} exit=${exitHref(browser, href) ? 'attempted' : 'none'} ` +
      `route=/${new URL(href).pathname.split('/')[1] ?? ''}`
  );
  return captured;
}

/** Forgets the capture. Tests only: a document captures once. */
export function resetInAppBrowserGuardForTests(): void {
  captured = undefined;
}
