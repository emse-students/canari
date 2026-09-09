/**
 * WHERE THE FULL REACTION PICKER GOES, DECIDED FROM WHAT THE OPENER ALREADY KNOWS.
 *
 * Two controls open the same panel and they want different placements: the "+" at the end of the
 * hover toolbar's quick bar, and the "more emoji" row of the long-press action sheet. For a while
 * the panel worked out which one it was by querying the DOM for the toolbar's icon strip - and that
 * query is not a discriminator, because the strip is in the tree at EVERY width. It is merely
 * `hidden md:block`, so below 768px the panel anchored itself to a `display: none` node, whose rect
 * is all zeros, and landed in the top-left corner of the window.
 *
 * The opener knows which control it is. Carrying that one string is the whole fix, and it is the
 * repo's own rule: never learn by failing what a fact could have told you.
 */

/** Which control opened the full picker. `null` is the closed state - the panel has no other. */
export type MessagePickerOrigin = 'toolbar' | 'sheet' | null;

/**
 * The node the panel is positioned against.
 *
 * From the toolbar it is the icon STRIP, because that is where the pointer and the eye already are
 * - the message row is most of the window on a wide thread, and aligning to its edge opened the
 * panel a screen away from the button just pressed. From the sheet there is no strip on screen at
 * all and the row is both the right answer and the only one.
 *
 * Generic over the node type so the decision can be tested without a DOM.
 */
export function pickerAnchor<T>(origin: MessagePickerOrigin, row: T | null, strip: T | null) {
  return origin === 'toolbar' ? strip : row;
}

/**
 * Whether the panel pins its RIGHT edge to the anchor's, rather than its left.
 *
 * Against the message ROW, an own message is right-aligned and so is its panel. Against the STRIP
 * the side MIRRORS: the strip sits in the gutter on the far side of the bubble, so an own message's
 * popovers grow rightward away from it - which is exactly what the quick bar does (`left-0` when
 * `isOwn`). Pinning the right edge there sent the panel off in the opposite direction from the bar
 * it replaces, measured at 174px of disagreement on 2026-09-09.
 */
export function pickerAlignsToEnd(origin: MessagePickerOrigin, isOwn: boolean): boolean {
  return origin === 'toolbar' ? !isOwn : isOwn;
}
