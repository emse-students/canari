/**
 * Which date separator the floating "sticky date" pill should name, given where each one sits.
 *
 * THE ANSWER IS THE LAST SEPARATOR AT OR ABOVE THE TOP OF THE PANE - the day whose messages the
 * reader is currently looking at. Separators are in document order, so their tops are sorted, so
 * the predicate "is at or above the line" is true for a prefix and false after it. That is what
 * makes a binary search correct here, and the linear walk it replaces was O(history above the
 * reader): at the bottom of a three-month thread it measured ninety elements, each one a forced
 * layout, on every scroll measurement.
 *
 * `topAt` is a function rather than an array of numbers so that a caller measures only the few
 * elements the search actually visits. Passing pre-measured tops would put every layout read back.
 *
 * WHEN NOTHING IS ABOVE THE LINE the first separator is named, which is what the walk did with its
 * seed value: the reader is at the very top of the history, and the first day is the one on screen.
 *
 * @param count how many separators there are; the caller guarantees it is at least 1
 * @param topAt the separator's top edge, in pixels relative to the top of the scrolling pane
 * @param line how far below the pane's top edge a separator still counts as "above"
 */
export function stickyDateIndex(
  count: number,
  topAt: (index: number) => number,
  line = 40
): number {
  let lo = 0;
  let hi = count - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** A separator's vertical box, in pixels relative to the top of the visible pane. */
export interface SeparatorBox {
  top: number;
  bottom: number;
}

/**
 * Which separator the floating pill should name, or `null` when it should not show at all.
 *
 * THE PILL IS A STAND-IN FOR A SEPARATOR THE READER CAN NO LONGER SEE, so it is withheld while the
 * one it would name is still on screen below whatever covers the top of the pane. Shown anyway it
 * drew a second copy of the same day right over the first one - two pills stacked, one partly
 * hiding the other - and, measured against the panel rather than the visible pane, it named the
 * PREVIOUS day over a separator that had just come into view under the header.
 *
 * @param count how many separators there are; the caller guarantees it is at least 1
 * @param boxAt the separator's box, relative to the top of the visible pane (under the header)
 * @param covered how much of the pane's top is hidden by a banner, in pixels
 * @param zone how tall the pill's own band is below `covered`; a separator within it counts as passed
 */
export function floatingDateIndex(
  count: number,
  boxAt: (index: number) => SeparatorBox,
  covered = 0,
  zone = 40
): number | null {
  const index = stickyDateIndex(count, (i) => boxAt(i).top, covered + zone);
  return boxAt(index).bottom > covered ? null : index;
}
