/**
 * ONE ANSWER TO "IS THE READER SELECTING TEXT?", FOR EVERY HORIZONTAL GESTURE IN THE APP.
 *
 * Post and message text is selectable on a phone (`.post-markdown`, `select-text`), and the stroke
 * that moves a selection is a HORIZONTAL DRAG. On iOS the long press that starts a selection hands
 * its own finger on to the selection (the touch keeps delivering `touchmove` to the page while the
 * range grows), and the native selection handles keep delivering them too - `touch-action` does not
 * cover either, it is a hint to the scroller and the handles are not asked. So every gesture that
 * listens for a horizontal drag - the tab swipe, the reply swipe, the edge swipe back - saw a
 * selection being dragged as a stroke of its own, and the whole page slid toward the neighbouring
 * tab under the reader's thumb (user, iPhone 1.0.0, 2026-10-01).
 *
 * A gesture therefore asks this BEFORE it starts and on EVERY move: while a range is selected the
 * finger belongs to the selection, and the gesture is abandoned, not paused. No timer and no
 * distance heuristic is involved - the engine states the fact (`selectionchange`, `isCollapsed`)
 * and this reads it.
 *
 * What it cannot see: WebKit's handles are native chrome. A drag that begins on one is only ever
 * observable as the selection existing, which is exactly what is asked here - so the answer is the
 * same whether the touch is a handle, the continuing long press, or a stroke inside the range.
 */

/**
 * True while a non-empty range of page text is selected.
 *
 * A caret inside a text field is collapsed and answers false; a field's own selected text does
 * not appear on `window.getSelection()` as a range on WebKit, and those targets are excluded from
 * every gesture already (`shouldIgnoreSwipeTarget`).
 */
export function hasActiveTextSelection(
  selection: Selection | null = typeof window === 'undefined' ? null : window.getSelection()
): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return selection.toString().length > 0;
}

/**
 * Calls `onSelect` each time the document's selection becomes (or stays) a non-empty range - the
 * event half of `hasActiveTextSelection`, for a gesture that must be abandoned the moment the
 * range appears rather than at the next `touchmove`. Returns the unsubscribe.
 */
export function onTextSelectionActive(onSelect: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (hasActiveTextSelection()) onSelect();
  };
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
