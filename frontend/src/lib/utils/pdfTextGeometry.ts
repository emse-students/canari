/**
 * Placing a PDF's text runs over its rasterised page, in units that survive a re-render.
 *
 * The reader rasterises each page and re-rasterises it per zoom step, so the bitmap's pixel size
 * changes under the text. Every box here is therefore expressed as a FRACTION of the page box on
 * each axis: one extraction then serves every zoom level, every column width and every device pixel
 * ratio, and nothing has to be recomputed when a page is re-rendered at a new width. Pixels would
 * have tied the text layer to one particular rasterisation and made a zoom silently misalign it.
 *
 * Kept pure and separate from the component because this is the part that can be wrong in a way
 * nobody sees - a selection highlight a few pixels off reads as "the PDF is a bit odd" rather than
 * as a bug - and because it is arithmetic over a matrix, which is exactly what a test can pin.
 */

/** The 6-element affine matrix pdf.js uses, `[a, b, c, d, e, f]`. */
export type Matrix = readonly [number, number, number, number, number, number];

/** A text run's box and orientation, in fractions of the page box (origin top-left, y down). */
export interface TextRunBox {
  /** Left edge, as a fraction of the page width. */
  left: number;
  /** Top edge, as a fraction of the page height. */
  top: number;
  /** Run width, as a fraction of the page width. */
  width: number;
  /** Glyph height, as a fraction of the page HEIGHT - this is the run's font size. */
  fontHeight: number;
  /** Rotation in radians, clockwise. 0 for ordinary horizontal text. */
  angle: number;
}

/**
 * Narrows pdf.js's loosely typed `number[]` transform into a {@link Matrix}, or reports its absence.
 *
 * A cast would have been shorter and would have asserted something the type does not know: pdf.js
 * declares these as plain arrays, so nothing guarantees six entries, and a five-entry array cast to
 * a tuple yields an `undefined` that arithmetic turns into `NaN` and CSS then swallows. Checking
 * costs one comparison per run and makes a malformed document skip a run rather than misplace it.
 */
export function asMatrix(values: readonly number[] | undefined | null): Matrix | null {
  if (!values || values.length !== 6) return null;
  const [a, b, c, d, e, f] = values;
  return [a, b, c, d, e, f];
}

/**
 * Composes two affine matrices, `m1 . m2` - pdf.js's `Util.transform`.
 *
 * Reimplemented rather than imported so this module stays pure and testable without loading pdf.js
 * (which pulls a worker and a dynamic chunk); it is six multiplications and the shape is fixed by
 * the format.
 */
export function composeMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Box of one text run, given the page's viewport transform at scale 1 and the run's own transform.
 *
 * PDF user space has its origin at the bottom-left with y pointing UP, and a text run's transform
 * places its BASELINE. The viewport transform flips that into the usual screen orientation, after
 * which the run's top edge is its baseline minus one glyph height - which is why the ascent is
 * approximated by the font height rather than measured: the real ascent needs the font, the font
 * needs the glyph data, and the difference is invisible behind text that is transparent anyway.
 *
 * @param viewportTransform - `page.getViewport({ scale: 1 }).transform`.
 * @param runTransform - `item.transform` from `page.getTextContent()`.
 * @param runWidth - `item.width`, in text space at scale 1.
 * @param pageWidth - viewport width at scale 1, in CSS pixels.
 * @param pageHeight - viewport height at scale 1, in CSS pixels.
 * @returns the box in page fractions, or `null` when the page has no area to divide by - returning
 *   the absence rather than a NaN box, which would reach `style.left` and fail invisibly.
 */
export function textRunBox(
  viewportTransform: Matrix,
  runTransform: Matrix,
  runWidth: number,
  pageWidth: number,
  pageHeight: number
): TextRunBox | null {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;

  const t = composeMatrix(viewportTransform, runTransform);
  if (!t.every((value) => Number.isFinite(value))) return null;

  // Glyph height is the length of the transformed vertical unit vector - NOT `t[3]`, which is only
  // the height for unrotated text and collapses to 0 at 90 degrees.
  const fontHeight = Math.hypot(t[2], t[3]);
  if (!(fontHeight > 0)) return null;

  const angle = Math.atan2(t[1], t[0]);
  // Same reasoning horizontally: the run's advance is measured along its own baseline.
  const scaleX = Math.hypot(t[0], t[1]);

  return {
    left: t[4] / pageWidth,
    top: (t[5] - fontHeight) / pageHeight,
    width: (runWidth * scaleX) / pageWidth,
    fontHeight: fontHeight / pageHeight,
    angle,
  };
}

/**
 * Horizontal scale that makes a rendered span exactly as wide as the run it stands for.
 *
 * The span is laid out in whatever font the browser substitutes, so its natural width is never the
 * PDF's. Selection highlights follow the SPAN, so an unscaled layer drifts further from the glyphs
 * with every word - which is the difference between a selection that looks right and one that
 * visibly lags the text. pdf.js corrects the same way, and this is the same one line.
 *
 * Returns 1 when there is nothing to compare, so an unmeasurable span is left alone rather than
 * collapsed to zero width.
 */
export function horizontalScale(targetWidth: number, naturalWidth: number): number {
  if (!(naturalWidth > 0) || !(targetWidth > 0)) return 1;
  return targetWidth / naturalWidth;
}
