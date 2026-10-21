import { Log } from '$lib/utils/Log';
import { CAMERA_PLACE } from '$lib/navigation/places';
import { swipeNavTargetHref } from '$lib/utils/swipeNavigation';

/** The JavaScript interface `MainActivity` registers as `canariGestures` (Android only). */
type GestureBridge = {
  setRightBand?: (topPx: number, bottomPx: number) => void;
  clearRightBand?: () => void;
  setLeftBand?: (topPx: number, bottomPx: number) => void;
  clearLeftBand?: () => void;
};

type ScreenEdge = 'left' | 'right';

function bridge(): GestureBridge | undefined {
  return (window as unknown as { canariGestures?: GestureBridge }).canariGestures;
}

/** The bridge's two methods for one edge, so the reporting below is written once for both. */
function edgeMethods(native: GestureBridge, edge: ScreenEdge) {
  return edge === 'left'
    ? { set: native.setLeftBand, clear: native.clearLeftBand }
    : { set: native.setRightBand, clear: native.clearRightBand };
}

/**
 * Reports `surface`'s vertical span to the Android shell as the band of `edge` the system Back
 * gesture must not take, for as long as the surface is on screen. Native declares the exclusion
 * (`setSystemGestureExclusionRects`) and sizes its WIDTH from the real gesture inset; only the page
 * knows WHEN the surface is shown and WHERE it is, so it reports that span in PHYSICAL px (CSS px x
 * devicePixelRatio, the WebView's own scale). Re-reported when the surface is resized (keyboard,
 * chrome, rotation), never per frame.
 *
 * THE FLOATING CHROME OVER THE SURFACE'S BOTTOM IS NOT PART OF IT: the element reserves it as
 * `padding-bottom` (the conversation's composer, the feed's bottom bar), so its content ends above
 * `rect.bottom - paddingBottom`. Native keeps only 200 dp of what it is told, and sending the whole
 * rect would spend part of them where nothing is swiped.
 *
 * Absent in the browser and on iOS, where this is a no-op by design, not a fallback. Returns the
 * cleanup to call when the surface goes: an exclusion must not outlive it, or the system back swipe
 * from that edge would be dead on every other screen.
 */
function excludeEdgeOver(edge: ScreenEdge, surface: HTMLElement): () => void {
  const native = bridge();
  if (!native) return () => {};
  const { set, clear } = edgeMethods(native, edge);
  if (!set || !clear) return () => {};
  let lastKey = '';
  const publish = () => {
    const rect = surface.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const reserved = parseFloat(getComputedStyle(surface).paddingBottom) || 0;
    const top = Math.round(rect.top * dpr);
    const bottom = Math.round((rect.bottom - reserved) * dpr);
    if (bottom <= top) return;
    const key = `${top}:${bottom}`;
    if (key === lastKey) return;
    lastKey = key;
    Log.d('GESTURE', `${edge}-edge exclusion over ${top}..${bottom} px`);
    set.call(native, top, bottom);
  };
  publish();
  // The keyboard animation resizes the surface many times a second: coalesce to the last value,
  // which is always sent (a trailing rate limit, not a correctness timer).
  let pending: ReturnType<typeof setTimeout> | null = null;
  const observer = new ResizeObserver(() => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      publish();
    }, 100);
  });
  observer.observe(surface);
  return () => {
    if (pending !== null) clearTimeout(pending);
    observer.disconnect();
    Log.d('GESTURE', `${edge}-edge exclusion cleared`);
    clear.call(native);
  };
}

/**
 * The RIGHT edge over a conversation's message list.
 *
 * WHY: an own bubble ends 12 px from the right edge, so its last 17.5 px sit inside Android's
 * back-gesture inset (`mEdgeWidthRight=74` physical px on the Mi 9T) and a reply swipe started there
 * is taken by the system - it closes the conversation (11 of 11, 2026-10-14). Native keeps the
 * BOTTOM 200 dp of the span, where the newest bubbles are.
 */
export function excludeRightEdgeOver(list: HTMLElement): () => void {
  return excludeEdgeOver('right', list);
}

/**
 * The LEFT edge over the posts feed, while the feed is shown.
 *
 * WHY: the swipe right from the feed opens the camera, and one started inside Android's left
 * back-gesture inset (`mEdgeWidthLeft=74` physical px, 30 CSS px on the Mi 9T) is taken by the
 * system as Back - 8 of 8 on 2026-10-21, the page saw only `touchstart > touchcancel`. Native keeps
 * 200 dp around the MIDDLE of the span, where a thumb starts that swipe.
 */
export function excludeLeftEdgeOver(feed: HTMLElement): () => void {
  return excludeEdgeOver('left', feed);
}

/** The feed's own path; its post pages (`/posts/<id>`) keep the left-edge Back to return to it. */
const FEED_PATH = '/posts';

/**
 * Whether the LEFT-edge exclusion is wanted on this screen - the only place it may exist.
 *
 * ONLY THE FEED ITSELF, AND ONLY WHILE ITS SWIPE TO THE CAMERA CAN HAPPEN: the swipe is armed on
 * this layout (`isSwipeNavArmed`), the camera is the feed's `prev` (so a reordering of the swipe
 * places drops the exclusion instead of leaving it on a feed that no longer swipes there), and the
 * keyboard is down (the tab swipe stands down while it is up, and Back is then what closes it), and
 * nothing covers the screen (`screenCover.covered`: a reel viewer, a full-screen media viewer, a
 * modal, the composer's camera - each is closed by Back, and the feed's swipe is not reachable
 * under it). A post page, a conversation, the camera and every other route keep the system Back
 * from the left edge untouched.
 */
export function wantsFeedLeftEdgeExclusion(
  pathname: string,
  swipeNavArmed: boolean,
  keyboardOpen: boolean,
  screenCovered: boolean
): boolean {
  return (
    swipeNavArmed &&
    !keyboardOpen &&
    !screenCovered &&
    pathname === FEED_PATH &&
    swipeNavTargetHref(pathname, 'prev') === CAMERA_PLACE.href
  );
}

/**
 * A NEW DOCUMENT OWNS NO BAND. Native keeps the last spans it was told across a page reload (the
 * activity and its WebView survive `location.reload()`, which the MLS recovery paths call), so a
 * reload from an open conversation or the feed would leave that edge's Back dead on whatever screen
 * the new document opens. Called once when the root layout is created, before any surface reports.
 */
export function clearEdgeExclusionsForNewDocument(): void {
  const native = bridge();
  if (!native) return;
  Log.d('GESTURE', 'new document: both edge exclusions cleared');
  native.clearLeftBand?.();
  native.clearRightBand?.();
}
