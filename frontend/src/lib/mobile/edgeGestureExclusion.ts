import { Log } from '$lib/utils/Log';

/** The JavaScript interface `MainActivity` registers as `canariGestures` (Android only). */
type GestureBridge = {
  setRightBand?: (topPx: number, bottomPx: number) => void;
  clearRightBand?: () => void;
};

function bridge(): GestureBridge | undefined {
  return (window as unknown as { canariGestures?: GestureBridge }).canariGestures;
}

/**
 * Tells the Android shell which vertical span of the window's RIGHT edge must not start the system
 * Back gesture, for as long as the conversation's message list is on screen.
 *
 * WHY: an own bubble ends 12 px from the right edge, so its last 17.5 px sit inside Android's
 * back-gesture inset (`mEdgeWidthRight=74` physical px on the Mi 9T) and a reply swipe started there
 * is taken by the system - it closes the conversation. Native declares the exclusion
 * (`setSystemGestureExclusionRects`); only the page knows WHEN a conversation is open and WHERE
 * its list is, so it reports that span in PHYSICAL px (CSS px x devicePixelRatio, the WebView's own
 * scale). Re-reported when the list is resized (keyboard, chrome), never per frame.
 *
 * Absent in the browser and on iOS, where this is a no-op by design, not a fallback. Returns the
 * cleanup to call when the list unmounts: the exclusion must not outlive the conversation, or the
 * system back swipe from the right edge would be dead on every other screen.
 */
export function excludeRightEdgeOver(list: HTMLElement): () => void {
  const native = bridge();
  if (!native?.setRightBand) return () => {};
  let lastKey = '';
  const publish = () => {
    const rect = list.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // THE COMPOSER FLOATS OVER THE LIST'S BOTTOM: the list reserves it as padding-bottom
    // (`--chat-composer-height`, plus the keyboard lift while it is up), so the bubbles end above
    // `rect.bottom - paddingBottom`. Native keeps only the BOTTOM 200 dp of what it is told, and
    // sending the whole rect would spend most of them on the composer and the nav inset.
    const reserved = parseFloat(getComputedStyle(list).paddingBottom) || 0;
    const top = Math.round(rect.top * dpr);
    const bottom = Math.round((rect.bottom - reserved) * dpr);
    if (bottom <= top) return;
    const key = `${top}:${bottom}`;
    if (key === lastKey) return;
    lastKey = key;
    Log.d('GESTURE', `right-edge exclusion over bubbles ${top}..${bottom} px`);
    native.setRightBand?.(top, bottom);
  };
  publish();
  // The keyboard animation resizes the list many times a second: coalesce to the last value, which
  // is always sent (a trailing rate limit, not a correctness timer).
  let pending: ReturnType<typeof setTimeout> | null = null;
  const observer = new ResizeObserver(() => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      publish();
    }, 100);
  });
  observer.observe(list);
  return () => {
    if (pending !== null) clearTimeout(pending);
    observer.disconnect();
    Log.d('GESTURE', 'right-edge exclusion cleared');
    native.clearRightBand?.();
  };
}
