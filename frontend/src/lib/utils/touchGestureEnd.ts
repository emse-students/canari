/**
 * LISTENS FOR THE END OF A TOUCH ON THE ELEMENT THE TOUCH BEGAN ON - not on an ancestor.
 *
 * WHY: a touch's `touchmove`/`touchend`/`touchcancel` are always dispatched to the element the
 * touch STARTED on. If a re-render removes that element mid-gesture, its events no longer bubble
 * to any ancestor, so a gesture that listens on the app shell never sees its own end: the tab swipe
 * left the page wrapper parked at its drag offset (about 100px left, with `touch-action: none`)
 * for good, and the next route inherited it. Measured on the Mi 9T 2026-10-06 by removing the
 * touched node between a drag and the release. Listening on the start target cannot lose the end.
 *
 * @returns a disposer that removes both listeners; the handler also disposes itself on first call.
 */
export function onTouchGestureEnd(
  target: EventTarget,
  handler: (e: TouchEvent) => void
): () => void {
  const dispose = () => {
    target.removeEventListener('touchend', onEnd);
    target.removeEventListener('touchcancel', onEnd);
  };
  const onEnd = (e: Event) => {
    dispose();
    handler(e as TouchEvent);
  };
  target.addEventListener('touchend', onEnd, { passive: true });
  target.addEventListener('touchcancel', onEnd, { passive: true });
  return dispose;
}
