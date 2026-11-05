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
  /** The viewport size the current frame was computed for: a different one makes the frame stale. */
  let framedWidth = 0;
  let framedHeight = 0;

  function disconnect(): void {
    io?.disconnect();
    io = null;
  }

  function arm(report: boolean, threshold = 1): void {
    disconnect();
    if (stopped) return;
    const { left, top, width, height } = element.getBoundingClientRect();
    if (report) onMove();
    // No box (hidden, detached): nothing to frame. The resize observer below re-arms when it gains one.
    if (!width || !height) return;
    framedWidth = root.clientWidth;
    framedHeight = root.clientHeight;
    const insets = [
      Math.floor(top),
      Math.floor(framedWidth - (left + width)),
      Math.floor(framedHeight - (top + height)),
      Math.floor(left),
    ];
    // A box partly off screen is framed too: its negative inset becomes a positive margin that
    // grows the root, so the ratio is 1 there as well (measured in Chromium). The real limit is a
    // box clipped by an ancestor scroller: its ratio is below 1 from the start, handled by the
    // first-callback branch below, and moves are still seen against that ratio.
    const rootMargin = insets.map((inset) => `${-inset}px`).join(' ');
    let first = true;
    io = new IntersectionObserver(
      (entries) => {
        const ratio = entries[entries.length - 1].intersectionRatio;
        if (first) {
          first = false;
          // Clipping or rounding can leave the box short of the frame: the threshold that must be
          // crossed is then the ratio actually seen, so re-arm on it. Not a move.
          if (ratio > 0 && ratio !== threshold) arm(false, ratio);
          return;
        }
        if (ratio !== threshold) arm(true);
      },
      { root: element.ownerDocument, rootMargin, threshold }
    );
    io.observe(element);
  }

  // The frame is made of the viewport's size and the element's box, so a change of either must
  // re-frame: a window that GROWS leaves slack the observer cannot see, and an element that had no
  // box (hidden by a breakpoint, not yet laid out) has no observer at all until it gains one.
  const resizes =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          if (stopped) return;
          for (const entry of entries) {
            if (entry.target === root) {
              if (io && (root.clientWidth !== framedWidth || root.clientHeight !== framedHeight)) {
                arm(true);
                return;
              }
            } else if (!io) {
              const box = element.getBoundingClientRect();
              if (box.width && box.height) {
                arm(true);
                return;
              }
            }
          }
        })
      : null;
  resizes?.observe(root);
  resizes?.observe(element);

  arm(false);
  return () => {
    stopped = true;
    resizes?.disconnect();
    disconnect();
  };
}
