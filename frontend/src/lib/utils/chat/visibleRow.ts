/**
 * Where the reader is in a thread: the last message row in view, as a pure measurement.
 *
 * Kept out of `ChatArea` so the arithmetic - which edge counts as "the bottom", which row survives
 * when the list changes - is testable with stubbed rects instead of a layout engine.
 */

/** The last row the reader can see: its id AND its position in display order when it was measured. */
export interface VisibleAnchor {
  id: string;
  index: number;
}

/**
 * The y coordinate under which a row is visible. The scroller runs UNDER the floating composer (its
 * `padding-bottom` is the composer's height, app.css), so its box bottom is not the reader's bottom:
 * a row behind the composer is not in view.
 */
export function viewportBottom(containerBottom: number, paddingBottom: number): number {
  return containerBottom - (Number.isFinite(paddingBottom) ? paddingBottom : 0);
}

/**
 * The index of the last row whose top edge is above `limit`, or -1. Rows are in DOM order, so their
 * tops increase and "above the limit" is a prefix: a binary search reads O(log n) rects per frame.
 * `topOf` returns `-Infinity` for a row above what is drawn, `Infinity` for one below or not mounted.
 */
export function lastRowAbove(
  count: number,
  topOf: (index: number) => number,
  limit: number
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) < limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Where `anchor` is in the thread NOW. The id is looked up first (the thread changes under a
 * reader); when it has gone - deleted, the list reloaded, a local id swapped for the server's - the
 * nearest surviving row in display order stands in, so the count never silently drops to 0.
 *
 * @returns `index` -1 for an empty thread or no anchor; `exact` false when the id was not found.
 */
export function resolveAnchor(
  ids: ReadonlyArray<string>,
  anchor: VisibleAnchor | null
): { index: number; exact: boolean } {
  if (anchor === null || ids.length === 0) return { index: -1, exact: true };
  if (ids[anchor.index] === anchor.id) return { index: anchor.index, exact: true };
  const at = ids.indexOf(anchor.id);
  if (at >= 0) return { index: at, exact: true };
  return { index: Math.min(Math.max(anchor.index, 0), ids.length - 1), exact: false };
}
