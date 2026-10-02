/**
 * CLAIMS A `touchmove` FOR A GESTURE OF OURS - or says it cannot be claimed.
 *
 * WHY: once the engine is scrolling (a fling still running when the finger comes down again, a drag
 * already handed to the compositor) its `touchmove` events are `cancelable=false`, and
 * `preventDefault()` on one does nothing except log "Ignored attempt to cancel a touchmove event
 * with cancelable=false" - found on the Mi 9T on 2026-10-02 by swiping sideways right after a
 * vertical fling, in the tab swipe's `handleTouchMove`. A move that cannot be cancelled belongs to
 * the scroller, so the gesture is released to it rather than half-claimed; this returns `false` and
 * the caller stands the gesture down.
 *
 * @returns true when the move was claimed (default prevented), false when it is the scroller's.
 */
export function claimTouchMove(e: Pick<TouchEvent, 'cancelable' | 'preventDefault'>): boolean {
  if (!e.cancelable) {
    console.debug('[touch] touchmove is not cancelable (a scroll is in progress) - not claimed');
    return false;
  }
  e.preventDefault();
  return true;
}
