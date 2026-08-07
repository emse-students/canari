/**
 * Focal-point maths for a pinch gesture over a scrollable, re-rasterised document.
 *
 * Kept pure and separate from any component because the two full-screen viewers must eventually
 * share one gesture (WP-VIEWER-1), and because the interesting part - keeping the point under the
 * fingers under the fingers - is arithmetic, not DOM work, and is worth pinning with tests.
 *
 * The model is an ANCHOR, not a scale ratio. A scale ratio assumes every pixel of the document
 * scales together, and in a paged column that is false: the gutters between pages and the
 * container's padding are fixed CSS lengths that do not grow with the zoom, so a ratio-based
 * correction overshoots by `(ratio - 1) x (padding + gutters above the pinched page)` - measured at
 * 48 px on page 2 at x3, and growing with every page deeper into the document. Anchoring on the
 * pinched page's own re-laid-out box is exact whatever the surrounding chrome does.
 */

/** A scroll position, in CSS pixels, of the element that owns the document's overflow. */
export interface ScrollOffset {
  scrollLeft: number;
  scrollTop: number;
}

/** Where inside an element the focal point sits, as a fraction of its box on each axis. */
export interface AnchorFraction {
  fracX: number;
  fracY: number;
}

/** A box, in the coordinates of the scroll container's own border box. */
export interface RelativeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AnchorScrollInput extends ScrollOffset, AnchorFraction {
  /** Focal point relative to the scroll container's own top-left corner, NOT to the viewport. */
  focalX: number;
  focalY: number;
  /** The anchor element's box AFTER the relayout, in those same coordinates. */
  anchor: RelativeBox;
  /** Optional clamps, so the caller never asks the browser for an out-of-range scroll. */
  maxScrollLeft?: number;
  maxScrollTop?: number;
}

/**
 * Fraction of `box` at which `focal` sits, or `null` when the box has no area to divide by.
 *
 * Returning the absence rather than a `NaN` fraction matters: a NaN would travel all the way to
 * `scrollLeft`, where the DOM swallows it, and the correction would fail invisibly instead of
 * being skipped honestly.
 */
export function anchorFraction(
  focal: { x: number; y: number },
  box: RelativeBox
): AnchorFraction | null {
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
  if (box.width <= 0 || box.height <= 0) return null;
  return { fracX: (focal.x - box.left) / box.width, fracY: (focal.y - box.top) / box.height };
}

/**
 * Scroll offsets that put the anchored content point back under the focal point.
 *
 * The anchor box is read after the relayout but before the scroll is touched, so it is already
 * expressed at the current scroll: the content point sits at `anchor.left + anchor.width * fracX`,
 * and moving it onto `focalX` means scrolling by exactly the difference.
 */
export function anchorScroll(input: AnchorScrollInput): ScrollOffset {
  const { scrollLeft, scrollTop, focalX, focalY, anchor, fracX, fracY } = input;
  if (!Number.isFinite(fracX) || !Number.isFinite(fracY)) return { scrollLeft, scrollTop };
  if (!Number.isFinite(anchor.width) || !Number.isFinite(anchor.height)) {
    return { scrollLeft, scrollTop };
  }
  if (anchor.width <= 0 || anchor.height <= 0) return { scrollLeft, scrollTop };

  const clamp = (value: number, max: number | undefined) => {
    const lower = Math.max(0, value);
    return max === undefined ? lower : Math.min(lower, Math.max(0, max));
  };

  return {
    scrollLeft: clamp(
      scrollLeft + (anchor.left + anchor.width * fracX - focalX),
      input.maxScrollLeft
    ),
    scrollTop: clamp(scrollTop + (anchor.top + anchor.height * fracY - focalY), input.maxScrollTop),
  };
}

/**
 * Index of the box containing `y`, or of the nearest one when `y` falls in a gutter between them.
 *
 * A pinch centred on the gap between two pages must still anchor on a page: refusing to anchor
 * there would make the correction silently depend on where the fingers happened to land.
 */
export function nearestBoxIndex(y: number, boxes: readonly { top: number; height: number }[]) {
  if (boxes.length === 0) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < boxes.length; i++) {
    const { top, height } = boxes[i];
    if (y >= top && y <= top + height) return i;
    const distance = y < top ? top - y : y - (top + height);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Index of the entry in `steps` closest to `value`.
 *
 * A document viewer settles on discrete steps because each one costs a re-rasterisation; the
 * gesture is continuous but its outcome is not. Ties go to the LOWER index: overshooting into a
 * more expensive render because a gesture landed exactly between two steps is the worse failure.
 */
export function nearestStepIndex(value: number, steps: readonly number[]): number {
  if (steps.length === 0) return 0;
  let best = 0;
  let bestDistance = Math.abs(steps[0] - value);
  for (let i = 1; i < steps.length; i++) {
    const distance = Math.abs(steps[i] - value);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** Midpoint of two touch points, in viewport coordinates. */
export function touchMidpoint(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number }
) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/** Distance between two touch points, in viewport coordinates. */
export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number }
) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
