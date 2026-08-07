/**
 * Focal-point maths for a pinch gesture over a scrollable, re-rasterised document.
 *
 * Kept pure and separate from any component because the two full-screen viewers must eventually
 * share one gesture (WP-VIEWER-1), and because the interesting part - keeping the point under the
 * fingers under the fingers - is arithmetic, not DOM work, and is worth pinning with tests.
 *
 * The model: content is laid out at a scale of `from`, and is about to be laid out at `to`. A
 * point of the CONTENT sits under the viewport coordinate `focal`. After the relayout the same
 * content point must sit under the same viewport coordinate, which is only true for one pair of
 * scroll offsets - the pair this module computes.
 */

/** A scroll position, in CSS pixels, of the element that owns the document's overflow. */
export interface ScrollOffset {
  scrollLeft: number;
  scrollTop: number;
}

export interface FocalScrollInput extends ScrollOffset {
  /** Focal point relative to the scroll container's own top-left corner, NOT to the viewport. */
  focalX: number;
  focalY: number;
  /** Scale the content is currently laid out at, and the scale it is about to be laid out at. */
  from: number;
  to: number;
  /** Optional clamps, so the caller never asks the browser for an out-of-range scroll. */
  maxScrollLeft?: number;
  maxScrollTop?: number;
}

/**
 * Scroll offsets that keep the content point under `focal` under `focal` across a scale change.
 *
 * Derivation, for one axis: the content coordinate under the focal point is
 * `(scroll + focal) / from`. After the relayout that coordinate sits at `content * to`, so the
 * scroll that puts it back under `focal` is `content * to - focal`.
 *
 * A `from` of zero would be a division by zero and cannot describe a laid-out document, so it is
 * treated as "no information" and the offsets are returned unchanged rather than as `NaN` - a
 * NaN assigned to `scrollLeft` is silently swallowed by the DOM, which would make this fail
 * invisibly.
 */
export function focalScroll(input: FocalScrollInput): ScrollOffset {
  const { scrollLeft, scrollTop, focalX, focalY, from, to } = input;
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
    return { scrollLeft, scrollTop };
  }

  const contentX = (scrollLeft + focalX) / from;
  const contentY = (scrollTop + focalY) / from;

  const clamp = (value: number, max: number | undefined) => {
    const lower = Math.max(0, value);
    return max === undefined ? lower : Math.min(lower, Math.max(0, max));
  };

  return {
    scrollLeft: clamp(contentX * to - focalX, input.maxScrollLeft),
    scrollTop: clamp(contentY * to - focalY, input.maxScrollTop),
  };
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
