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

/**
 * The other representation of "keep the focal point still": a single element that carries the whole
 * zoom as a CSS `translate(...) scale(...)`.
 *
 * A photo is ONE bitmap with nothing around it that fails to scale, so the anchor machinery above is
 * unnecessary there - the transform itself is exact, and the arithmetic reduces to the two functions
 * below. The two models are kept in one module because they answer the same question and a viewer
 * may need either, but they are NOT interchangeable: applying this one to a paged column is exactly
 * the ratio-based correction the anchor model exists to replace.
 */

/** The geometry a translation must stay inside, all in CSS pixels at scale 1 except `scale`. */
export interface TranslationBounds {
  /** Size of the transformed content before scaling. */
  contentWidth: number;
  contentHeight: number;
  /** Size of the box it is transformed inside. */
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
}

/** A translate + scale transform, in the units a CSS `transform` consumes. */
export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Translation clamped so the content never scrolls past its own edges.
 *
 * The transform is applied about the CENTRE, so the travel available on each axis is half the
 * overflow. An axis with no overflow yields 0 rather than a negative bound, which is what snaps a
 * content smaller than its box back to the middle instead of letting it drift into a corner.
 */
export function clampTranslation(
  tx: number,
  ty: number,
  bounds: TranslationBounds
): [number, number] {
  const { contentWidth, contentHeight, viewportWidth, viewportHeight, scale } = bounds;
  if (!(scale > 1)) return [0, 0];
  if (
    ![contentWidth, contentHeight, viewportWidth, viewportHeight, tx, ty].every(Number.isFinite)
  ) {
    return [0, 0];
  }
  const maxTx = Math.max(0, (contentWidth * scale - viewportWidth) / 2);
  const maxTy = Math.max(0, (contentHeight * scale - viewportHeight) / 2);
  return [Math.max(-maxTx, Math.min(maxTx, tx)), Math.max(-maxTy, Math.min(maxTy, ty))];
}

export interface ZoomAboutPivotInput extends ZoomTransform {
  /** The scale being asked for, before clamping to `[minScale, maxScale]`. */
  nextScale: number;
  /** Pivot in CENTRE-relative coordinates of the transformed box - the point to hold still. */
  pivotX: number;
  pivotY: number;
  minScale?: number;
  maxScale?: number;
  /** When given, the result is clamped to it; otherwise the raw translation is returned. */
  bounds?: Omit<TranslationBounds, 'scale'>;
}

/**
 * The transform that scales to `nextScale` while keeping the content point under `pivot` under it.
 *
 * At the minimum scale the translation is reset rather than clamped. That is not the same thing: a
 * clamp would leave the content wherever the gesture ended if the arithmetic happened to land inside
 * the bounds, so pinching out and back would not return a photo to where it started - and "unzoom
 * puts it back" is the one thing a user is entitled to assume.
 */
export function zoomAboutPivot(input: ZoomAboutPivotInput): ZoomTransform {
  const { scale, tx, ty, pivotX, pivotY, minScale = 1, maxScale = 8, bounds } = input;
  const next = Math.max(minScale, Math.min(maxScale, input.nextScale));
  // A zero or non-finite current scale makes the ratio meaningless; refusing to compute is better
  // than emitting a NaN transform, which CSS drops silently and leaves the view frozen.
  if (!Number.isFinite(next) || !(scale > 0))
    return { scale: Math.max(minScale, next || minScale), tx: 0, ty: 0 };
  if (next <= minScale) return { scale: next, tx: 0, ty: 0 };

  const ratio = next / scale;
  const rawTx = tx * ratio + pivotX * (1 - ratio);
  const rawTy = ty * ratio + pivotY * (1 - ratio);
  if (!bounds) return { scale: next, tx: rawTx, ty: rawTy };

  const [clampedX, clampedY] = clampTranslation(rawTx, rawTy, { ...bounds, scale: next });
  return { scale: next, tx: clampedX, ty: clampedY };
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
