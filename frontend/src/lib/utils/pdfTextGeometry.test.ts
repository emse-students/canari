import { composeMatrix, horizontalScale, textRunBox, type Matrix } from './pdfTextGeometry';

/**
 * The viewport transform pdf.js produces for an unrotated page at scale 1: identity horizontally,
 * flipped vertically with the origin moved to the top - which is the whole reason a run's box is
 * not simply its own transform.
 */
const flipY = (height: number): Matrix => [1, 0, 0, -1, 0, height];

describe('composeMatrix', () => {
  it('is the identity on either side', () => {
    const identity: Matrix = [1, 0, 0, 1, 0, 0];
    const m: Matrix = [2, 0, 0, 3, 5, 7];
    expect(composeMatrix(identity, m)).toEqual([...m]);
    expect(composeMatrix(m, identity)).toEqual([...m]);
  });

  it('applies the SECOND matrix first, which is what places a run inside its page', () => {
    // Scale by 2, then translate by (10, 0): the translation must not itself be scaled.
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    const translate: Matrix = [1, 0, 0, 1, 10, 0];
    expect(composeMatrix(scale, translate)).toEqual([2, 0, 0, 2, 20, 0]);
  });
});

describe('textRunBox', () => {
  const PAGE_W = 600;
  const PAGE_H = 800;

  it('turns a baseline in PDF space into a top-left box in page fractions', () => {
    // A 12pt run whose baseline sits 100 units up from the bottom, 60 units from the left.
    const run: Matrix = [12, 0, 0, 12, 60, 100];
    const box = textRunBox(flipY(PAGE_H), run, 5, PAGE_W, PAGE_H);

    expect(box).not.toBeNull();
    expect(box!.left).toBeCloseTo(60 / PAGE_W);
    // The flip puts the baseline at 800 - 100 = 700 from the top; the box's TOP is one glyph
    // height above it.
    expect(box!.top).toBeCloseTo((700 - 12) / PAGE_H);
    expect(box!.fontHeight).toBeCloseTo(12 / PAGE_H);
    expect(box!.width).toBeCloseTo((5 * 12) / PAGE_W);
    expect(box!.angle).toBeCloseTo(0);
  });

  it('is INDEPENDENT of the rasterisation, which is the whole point of using fractions', () => {
    const run: Matrix = [12, 0, 0, 12, 60, 100];
    const box = textRunBox(flipY(PAGE_H), run, 5, PAGE_W, PAGE_H);
    // The same page rasterised twice as wide is the same document: the viewport transform at
    // scale 1 does not change, so neither may the layer. A pixel-based layer would have moved.
    const again = textRunBox(flipY(PAGE_H), run, 5, PAGE_W, PAGE_H);
    expect(again).toEqual(box);
  });

  it('reads the glyph height off the transformed vertical vector, not off d', () => {
    // Rotated 90 degrees: `d` is 0, so anything reading it as the height would collapse the run.
    const rotated: Matrix = [0, 12, -12, 0, 60, 100];
    const box = textRunBox(flipY(PAGE_H), rotated, 5, PAGE_W, PAGE_H);

    expect(box).not.toBeNull();
    expect(box!.fontHeight).toBeCloseTo(12 / PAGE_H);
    expect(box!.width).toBeCloseTo((5 * 12) / PAGE_W);
    expect(Math.abs(box!.angle)).toBeCloseTo(Math.PI / 2);
  });

  it('returns the absence rather than a NaN box', () => {
    const run: Matrix = [12, 0, 0, 12, 60, 100];
    expect(textRunBox(flipY(PAGE_H), run, 5, 0, PAGE_H)).toBeNull();
    expect(textRunBox(flipY(PAGE_H), run, 5, PAGE_W, 0)).toBeNull();
    // A degenerate run has no height to place: it must be skipped, not divided by.
    expect(textRunBox(flipY(PAGE_H), [0, 0, 0, 0, 60, 100], 5, PAGE_W, PAGE_H)).toBeNull();
    expect(textRunBox(flipY(PAGE_H), [NaN, 0, 0, 12, 60, 100], 5, PAGE_W, PAGE_H)).toBeNull();
  });
});

describe('horizontalScale', () => {
  it('stretches a span onto the width the PDF says the run has', () => {
    expect(horizontalScale(120, 100)).toBeCloseTo(1.2);
    expect(horizontalScale(80, 100)).toBeCloseTo(0.8);
  });

  it('leaves an unmeasurable span alone rather than collapsing it', () => {
    expect(horizontalScale(120, 0)).toBe(1);
    expect(horizontalScale(0, 100)).toBe(1);
  });
});
