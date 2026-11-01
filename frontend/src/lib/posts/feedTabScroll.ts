/**
 * Where the feed's tab row scrolls so the SELECTED tab is in full view (`FeedTabRow`).
 *
 * At 2x text on a 390 px phone the three tabs overflow their row, and the selected last tab (then "Tout") - the last
 * one - sat under the faded right edge, next to the CanaReels icon, until the reader scrolled the row
 * (Mi 9T, v1.2.9-alpha.4). The selected tab is centred in the row: a scroller clamps the offset at
 * both ends, so the first and last tabs land flush at their edge, where `scrollFades` draws no fade,
 * and a middle tab keeps a fade's width of room on each side.
 */

/** The horizontal extent of a box on screen, as `getBoundingClientRect` reports it. */
export interface HorizontalBox {
  left: number;
  width: number;
}

/**
 * The `scrollLeft` that centres `tab` in `row`, clamped to what the row can scroll (`maxScroll`,
 * i.e. `scrollWidth - clientWidth`). `scrollLeft` is the row's current offset: `tab` is measured on
 * screen, so its position in the content is its distance from the row plus that offset.
 */
export function centredTabScrollLeft(
  row: HorizontalBox,
  tab: HorizontalBox,
  scrollLeft: number,
  maxScroll: number
): number {
  if (maxScroll <= 0) return 0;
  const tabStartInContent = tab.left - row.left + scrollLeft;
  const centred = tabStartInContent + tab.width / 2 - row.width / 2;
  return Math.min(maxScroll, Math.max(0, Math.round(centred)));
}
