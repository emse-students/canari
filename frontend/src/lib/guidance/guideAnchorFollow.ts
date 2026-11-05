import { Log } from '$lib/utils/Log';

/**
 * TELLS YOU WHEN AN ELEMENT MOVED, WHATEVER MOVED IT - an event, never a poll.
 *
 * A `ResizeObserver` reports a change of SIZE only: content settling above a target (a skeleton
 * replaced by a shorter block, a banner leaving, a scrollbar appearing, a sidebar widening) moves
 * it with its size untouched, and the guide's spotlight then keeps a stale box (measured in Chromium,
 * docs/wiki/frontend/guided-help.md). `scroll` and `resize` listeners miss the same moves.
 *
 * The one browser event that does see every move is `IntersectionObserver`, used with a
 * `rootMargin` that shrinks the viewport to EXACTLY the element's current box: the element then
 * intersects its root at ratio 1, and the slightest shift or resize drops the ratio, which fires
 * the callback. Each report re-arms the observer around the new box, so the next move is seen too.
 * (The same technique as floating-ui's `layoutShift` option, kept here to carry no dependency.)
 *
 * @param element The element to follow.
 * @param onMove Called when its box has changed, and once when the follow is re-armed after it.
 * @returns The stop function.
 */
export function observeElementMoves(element: Element, onMove: () => void): () => void {
  if (typeof IntersectionObserver !== 'function') {
    Log.d('guide', 'IntersectionObserver is missing: the spotlight follows resize and scroll only');
    return () => {};
  }
  const root = element.ownerDocument.documentElement;
  let io: IntersectionObserver | null = null;
  let stopped = false;

  function disconnect(): void {
    io?.disconnect();
    io = null;
  }

  function arm(report: boolean, threshold = 1): void {
    disconnect();
    if (stopped) return;
    const { left, top, width, height } = element.getBoundingClientRect();
    if (report) onMove();
    // No box (hidden, detached): nothing to hug; the registry decides what that means.
    if (!width || !height) return;
    const insets = [
      Math.floor(top),
      Math.floor(root.clientWidth - (left + width)),
      Math.floor(root.clientHeight - (top + height)),
      Math.floor(left),
    ];
    // An element partly off screen cannot be framed by a root margin: a negative inset on a side
    // that is already outside the viewport is clamped to nothing, so the frame is the visible part
    // and a move of the hidden part is not seen. Scroll events cover that case.
    const rootMargin = insets.map((inset) => `${-inset}px`).join(' ');
    let first = true;
    io = new IntersectionObserver(
      (entries) => {
        const ratio = entries[entries.length - 1].intersectionRatio;
        if (first) {
          first = false;
          // Rounding or clipping can leave the box a hair short of the frame: the threshold that
          // must be crossed is then the ratio actually seen, so re-arm on it. Not a move.
          if (ratio > 0 && ratio !== threshold) arm(false, ratio);
          return;
        }
        if (ratio !== threshold) arm(true);
      },
      { root: element.ownerDocument, rootMargin, threshold }
    );
    io.observe(element);
  }

  arm(false);
  return () => {
    stopped = true;
    disconnect();
  };
}
