import { Log } from '$lib/utils/Log';
import { drainHistoryOverlayStack, historyOverlayStackDepth } from '$lib/utils/historyOverlayStack';

/**
 * The element the app's pages scroll in: `+layout.svelte` draws every route inside ONE
 * `overflow-y-auto` box, so the DOCUMENT never scrolls (`main` is `overflow-hidden`,
 * `.page-scroll-wrap` is `absolute inset-0 overflow-y-auto`). That is why a status bar tap does
 * nothing in WKWebView on its own - it only scrolls the web view's own scroll view.
 */
export const PAGE_SCROLLER_SELECTOR = '.page-scroll-wrap';

/** What a request to scroll to the top ended in - logged, and what the tests assert. */
export type ScrollToTopOutcome = 'scrolled' | 'already-at-top' | 'no-scroller' | 'overlay-open';

/** Who asked, for the log line only: ONE action, several triggers. */
export type ScrollToTopTrigger = 'tab-retap' | 'status-bar';

/**
 * THE ONE SCROLL-TO-TOP ACTION (owner, 2026-11-04): a re-tap of the selected tab (web bar, native iOS
 * bar, sidebar) and a tap on the iOS status bar both end here. Smooth, unless the reader asked for
 * reduced motion. It NEVER refreshes: it reports `already-at-top` and the caller decides
 * (`handlePlaceTap` refreshes on a re-tap at the top; a status bar tap does nothing more). A status
 * bar tap while a history overlay is open is skipped: the page behind it would move unseen.
 */
export function scrollPageToTop(trigger: ScrollToTopTrigger): ScrollToTopOutcome {
  if (trigger === 'status-bar' && historyOverlayStackDepth() > 0) {
    Log.d('scrollToTop', `${trigger}: an overlay is open, the page behind it stays put`);
    return 'overlay-open';
  }
  const scroller = document.querySelector<HTMLElement>(PAGE_SCROLLER_SELECTOR);
  if (!scroller) {
    Log.d('scrollToTop', `${trigger}: no page scroller mounted`);
    return 'no-scroller';
  }
  if (scroller.scrollTop <= 0) {
    Log.d('scrollToTop', `${trigger}: already at the top`);
    return 'already-at-top';
  }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  Log.d('scrollToTop', `${trigger}: from ${Math.round(scroller.scrollTop)}px`);
  scroller.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  return 'scrolled';
}

/**
 * Puts the page scroller back at the top AT ONCE, no animation, no refresh: what a change of feed tab
 * asks (owner, 2026-11-10) - the new tab is another list, and keeping the old tab's offset dropped the
 * reader in the middle of it. Distinct from {@link scrollPageToTop}, a smooth gesture the reader asked
 * for. Returns whether a scroller was there to reset.
 */
export function resetPageScroll(): boolean {
  const scroller = document.querySelector<HTMLElement>(PAGE_SCROLLER_SELECTOR);
  if (!scroller) {
    Log.d('scrollToTop', 'reset: no page scroller mounted');
    return false;
  }
  Log.d('scrollToTop', `reset from ${Math.round(scroller.scrollTop)}px`);
  scroller.scrollTop = 0;
  return true;
}

/**
 * Whether a tap on the place at `placeHref` is a RE-TAP: the reader is already on that place's own
 * page. Deeper in the place (`/posts/<id>`) the tap is a way back and must navigate, not scroll.
 */
export function isPlaceRetap(placeHref: string, pathname: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return trim(pathname) === trim(placeHref);
}

/** The open page's own refresh action (the feed's pull-to-refresh path), if it has one. */
let pageRefresh: (() => unknown) | null = null;

/**
 * A page offers its refresh action to the tab re-tap (owner, 2026-11-04): the feed registers the
 * SAME function its pull-to-refresh calls, so there is no second implementation. Returns the
 * unregister function for the page's teardown (it only clears its own registration).
 */
export function registerRetapRefresh(refresh: () => unknown): () => void {
  pageRefresh = refresh;
  return () => {
    if (pageRefresh === refresh) pageRefresh = null;
  };
}

/**
 * Handles a tap on a place: a re-tap returns `true` (the caller then must not navigate); anything
 * else returns `false` and the caller navigates as before. A re-tap first closes any open history
 * overlay (the same-URL navigation it replaces drained them) and stops there; otherwise the first
 * re-tap scrolls to the top, and a re-tap while ALREADY at the top refreshes the page when it
 * registered a refresh (Instagram).
 */
export function handlePlaceTap(placeHref: string, pathname: string): boolean {
  if (!isPlaceRetap(placeHref, pathname)) return false;
  Log.d('scrollToTop', `re-tap of ${placeHref}`);
  if (historyOverlayStackDepth() > 0) {
    drainHistoryOverlayStack();
    return true;
  }
  const outcome = scrollPageToTop('tab-retap');
  if (outcome === 'already-at-top' && pageRefresh) {
    if (refreshing) {
      Log.d('scrollToTop', `re-tap at the top of ${placeHref}: a refresh is already running`);
      return true;
    }
    Log.d('scrollToTop', `re-tap at the top of ${placeHref}: refreshing`);
    refreshing = true;
    void Promise.resolve()
      .then(() => pageRefresh?.())
      .catch((e) => console.warn(`[scrollToTop] refresh after a re-tap failed: ${String(e)}`))
      .finally(() => {
        refreshing = false;
      });
  }
  return true;
}

/**
 * The attribute that makes an anchor a PLACE link (`BottomNav`, `AppSidebar`): its value is the
 * place's href. The anchor declares itself and decides nothing - a click on it is decided by the ONE
 * owner of every in-app link click, `handleAppLinkClick` (`openExternal.ts`), a capture listener on
 * the document that runs before any handler on the anchor and stops the event. A re-tap gate in the
 * anchor's own `onclick` was dead code there (Mi 9T, `1.6.4-alpha.3`: three re-taps of the open Feed
 * tab, `[appLink] In-app navigation`, no `[scrollToTop]` line, the page still at 1378 px).
 */
export const PLACE_LINK_ATTRIBUTE = 'data-app-place';

/**
 * The place-link half of a link click, asked by `handleAppLinkClick` before it navigates: `true`
 * when `anchor` is a place link whose place is the page on screen, i.e. the click was a re-tap and
 * has been handled (the caller then cancels the navigation). Modifier keys and non-primary buttons
 * are the caller's to filter, as for every link.
 */
export function handlePlaceLinkClick(anchor: Element, pathname: string): boolean {
  const placeHref = anchor.getAttribute(PLACE_LINK_ATTRIBUTE);
  if (!placeHref) return false;
  return handlePlaceTap(placeHref, pathname);
}

/** True while a re-tap's refresh runs, so repeated re-taps do not start parallel ones. */
let refreshing = false;
