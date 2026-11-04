import { Log } from '$lib/utils/Log';

/**
 * The element the app's pages scroll in: `+layout.svelte` draws every route inside ONE
 * `overflow-y-auto` box, so the DOCUMENT never scrolls (`main` is `overflow-hidden`,
 * `.page-scroll-wrap` is `absolute inset-0 overflow-y-auto`). That is why a status bar tap does
 * nothing in WKWebView on its own - it only scrolls the web view's own scroll view.
 */
export const PAGE_SCROLLER_SELECTOR = '.page-scroll-wrap';

/** What a request to scroll to the top ended in - logged, and what the tests assert. */
export type ScrollToTopOutcome = 'scrolled' | 'already-at-top' | 'no-scroller';

/** Who asked, for the log line only: ONE action, several triggers. */
export type ScrollToTopTrigger = 'tab-retap' | 'status-bar';

/**
 * THE ONE SCROLL-TO-TOP ACTION (owner, 2026-11-04): a re-tap of the selected tab (web bar, native iOS
 * bar, sidebar) and a tap on the iOS status bar both end here. Smooth, unless the reader asked for
 * reduced motion. Already at the top it does nothing more - Instagram's own behaviour; the feed's
 * pull-to-refresh stays the only refresh gesture.
 */
export function scrollPageToTop(trigger: ScrollToTopTrigger): ScrollToTopOutcome {
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
 * else returns `false` and the caller navigates as before. The first re-tap scrolls to the top; a
 * re-tap while ALREADY at the top refreshes the page when it registered a refresh (Instagram).
 */
export function handlePlaceTap(placeHref: string, pathname: string): boolean {
  if (!isPlaceRetap(placeHref, pathname)) return false;
  Log.d('scrollToTop', `re-tap of ${placeHref}`);
  const outcome = scrollPageToTop('tab-retap');
  if (outcome === 'already-at-top' && pageRefresh) {
    Log.d('scrollToTop', `re-tap at the top of ${placeHref}: refreshing`);
    void Promise.resolve(pageRefresh()).catch((e) =>
      Log.d('scrollToTop', `refresh failed: ${String(e)}`)
    );
  }
  return true;
}
