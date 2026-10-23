/**
 * The reading of a scroll position as "should a collapsing header be shown", shared by anything that
 * hides on the way down and returns on the way up (the posts feed's tab row, first).
 *
 * It is a pure step so it can be tested without a DOM: the caller feeds each scroll position in,
 * keeps the returned state, and acts only when `shown` changed.
 */

/** What the reader did last: where the direction was last decided, and the header's state. */
export interface ScrollDirectionState {
  /** The scroll position the current direction is measured from (it follows the reader's extreme). */
  anchor: number;
  /** Whether the header is shown. */
  shown: boolean;
}

/** The distance, in px, a reader must travel against the current state before it flips. */
export const SCROLL_DEAD_ZONE_PX = 8;

/**
 * The state a page starts in: header shown, anchored at where the page already is (`top`, 0 when
 * omitted). A page restored mid-scroll is not at the top, and anchoring it at 0 would read its whole
 * offset as one scroll down on the first event and hide the header unasked.
 */
export function initialScrollDirection(top = 0): ScrollDirectionState {
  return { anchor: Math.max(0, top), shown: true };
}

/**
 * One step. The header is ALWAYS shown at the very top (`top <= 0`, which also covers an iOS
 * overscroll bounce above it). Elsewhere it flips to hidden after `deadZone` px DOWN and to shown
 * after `deadZone` px UP, measured from the furthest point reached in the current direction, so a
 * jitter, or a bounce that returns a few px, never flips it. The caller clamps `top` to the real
 * maximum so a bounce at the bottom does not read as an upward scroll.
 */
export function nextScrollDirection(
  state: ScrollDirectionState,
  top: number,
  deadZone: number = SCROLL_DEAD_ZONE_PX
): ScrollDirectionState {
  if (top <= 0) return state.shown && state.anchor === 0 ? state : { anchor: 0, shown: true };
  const delta = top - state.anchor;
  if (delta >= deadZone) return { anchor: top, shown: false };
  if (delta <= -deadZone) return { anchor: top, shown: true };
  // Inside the dead zone: keep the state, but let the anchor follow the extreme of the CURRENT
  // direction so the return distance is measured from where the reader turned.
  if (!state.shown && top > state.anchor) return { anchor: top, shown: false };
  if (state.shown && top < state.anchor) return { anchor: top, shown: true };
  return state;
}
