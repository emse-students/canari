/**
 * Vertical swipe-to-dismiss for the media lightbox - pulled out of the component as pure
 * functions for the same reason `swipeNavigation.ts` and `messageSwipeReply.ts` are: the
 * DOM read (which touch moved where) cannot be tested without a browser, so it is kept to a
 * single line at each call site and everything that decides what the gesture MEANS lives here.
 */

/** Vertical drag distance (px) past which releasing the swipe dismisses the viewer. */
export const LIGHTBOX_DISMISS_THRESHOLD_PX = 110;

/**
 * True while a one-finger drag should keep being tracked as a dismiss swipe rather than
 * abandoned - i.e. the vertical component still dominates the horizontal one. A mostly-sideways
 * drag is left alone (a tap that wobbled, or the start of some other gesture) rather than being
 * forced into a dismiss it was never aiming for.
 */
export function isVerticalDismissDrag(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) >= Math.abs(deltaX);
}

/** True when the released drag travelled far enough, in either direction, to dismiss. */
export function shouldDismissOnRelease(
  deltaY: number,
  threshold = LIGHTBOX_DISMISS_THRESHOLD_PX
): boolean {
  return Math.abs(deltaY) > threshold;
}
