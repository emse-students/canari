import {
  anchorFraction,
  anchorScroll,
  nearestBoxIndex,
  nearestStepIndex,
  touchDistance,
  touchMidpoint,
} from './pinchZoom';

/** Where a content point ends up on screen once `next` has been applied. */
const settledAt = (
  before: { scrollTop: number },
  next: { scrollTop: number },
  anchor: { top: number; height: number },
  fracY: number
) => anchor.top - (next.scrollTop - before.scrollTop) + anchor.height * fracY;

describe('anchorScroll', () => {
  it('keeps the point under the fingers under the fingers - the whole defect', () => {
    // Reported on device 2026-08-07: "pincher augmente le zoom, mais ca augmente pas a l'endroit
    // qu'on veut". The column was `origin-top` with no scroll correction at all, so the content
    // the user pinched drifted away by over a thousand pixels as the column widened.
    const before = { scrollLeft: 0, scrollTop: 0 };
    const anchor = { left: 0, top: 0, width: 900, height: 1200 };
    const next = anchorScroll({
      ...before,
      focalX: 200,
      focalY: 100,
      anchor,
      fracX: 0.5,
      fracY: 0.25,
    });
    // Content point sits at 900 * 0.5 = 450 across and 1200 * 0.25 = 300 down; the focal is at
    // (200, 100), so the scroll has to make up exactly the difference.
    expect(next).toEqual({ scrollLeft: 250, scrollTop: 200 });
  });

  it('is exact where a scale ratio overshoots, because gutters do not scale', () => {
    // MEASURED on device at x3 (probe-pdf-layout): the scroll container's 12 px padding and the
    // 12 px inter-page gap are fixed CSS lengths. Page 2 therefore sits at 12 + 1677 + 12 = 1701,
    // not at 3 x 583 = 1749. A ratio-based correction believes the latter and lands 48 px off -
    // and the error grows by 2 x 12 px for every further page, so it is not a rounding matter.
    const before = { scrollLeft: 0, scrollTop: 260 };
    const focalY = 449;
    // The pinched page BEFORE the zoom: content top 583, height 559, read against the scroll.
    const fraction = anchorFraction(
      { x: 0, y: focalY },
      { left: 0, top: 583 - before.scrollTop, width: 395, height: 559 }
    );
    expect(fraction).not.toBeNull();

    // The same page AFTER the relayout, still read against the untouched scroll.
    const anchor = { left: 0, top: 1701 - before.scrollTop, width: 1186, height: 1677 };
    const next = anchorScroll({
      ...before,
      focalX: 0,
      focalY,
      anchor,
      fracX: 0,
      fracY: fraction!.fracY,
    });

    expect(settledAt(before, next, anchor, fraction!.fracY)).toBeCloseTo(focalY, 6);
    // The ratio model - `(scroll + focal) * to / from - focal` - would have produced
    // (260 + 449) * 3 - 449 = 1678 here. The 48 px between them is the padding and the one gutter
    // above this page, multiplied by (3 - 1) because the ratio scales them and the layout does not.
    expect(next.scrollTop).toBe(1630);
    expect((before.scrollTop + focalY) * 3 - focalY - next.scrollTop).toBe(48);
  });

  it('zooms back out symmetrically', () => {
    const before = { scrollLeft: 250, scrollTop: 200 };
    const anchor = { left: -250, top: -200, width: 900, height: 1200 };
    expect(
      anchorScroll({ ...before, focalX: 200, focalY: 100, anchor, fracX: 0.5, fracY: 0.25 })
    ).toEqual({ scrollLeft: 250, scrollTop: 200 });
  });

  it('never returns a negative scroll, which the DOM would clamp silently anyway', () => {
    const out = anchorScroll({
      scrollLeft: 0,
      scrollTop: 0,
      focalX: 800,
      focalY: 800,
      anchor: { left: 0, top: 0, width: 100, height: 100 },
      fracX: 0.5,
      fracY: 0.5,
    });
    expect(out).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it('clamps to the caller-supplied maximum', () => {
    const out = anchorScroll({
      scrollLeft: 0,
      scrollTop: 0,
      focalX: 200,
      focalY: 100,
      anchor: { left: 0, top: 0, width: 900, height: 1200 },
      fracX: 0.5,
      fracY: 0.25,
      maxScrollLeft: 50,
      maxScrollTop: 25,
    });
    expect(out).toEqual({ scrollLeft: 50, scrollTop: 25 });
  });

  it('returns the offsets unchanged rather than NaN when the anchor is unusable', () => {
    // A NaN assigned to `scrollLeft` is swallowed by the DOM, so this would fail invisibly.
    const base = { scrollLeft: 10, scrollTop: 20, focalX: 5, focalY: 5, fracX: 0.5, fracY: 0.5 };
    const unusable = [
      { left: 0, top: 0, width: 0, height: 100 },
      { left: 0, top: 0, width: 100, height: 0 },
      { left: 0, top: 0, width: -5, height: 100 },
      { left: 0, top: 0, width: Number.NaN, height: 100 },
      { left: 0, top: 0, width: 100, height: Number.POSITIVE_INFINITY },
    ];
    for (const anchor of unusable) {
      expect(anchorScroll({ ...base, anchor })).toEqual({ scrollLeft: 10, scrollTop: 20 });
    }
    expect(
      anchorScroll({
        ...base,
        fracY: Number.NaN,
        anchor: { left: 0, top: 0, width: 100, height: 100 },
      })
    ).toEqual({ scrollLeft: 10, scrollTop: 20 });
  });
});

describe('anchorFraction', () => {
  it('reads where inside a box the focal point sits', () => {
    expect(
      anchorFraction({ x: 50, y: 300 }, { left: 0, top: 100, width: 200, height: 800 })
    ).toEqual({ fracX: 0.25, fracY: 0.25 });
  });

  it('returns the absence rather than a NaN fraction for an area-less box', () => {
    expect(anchorFraction({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    expect(anchorFraction({ x: 0, y: 0 }, { left: 0, top: 0, width: 10, height: 0 })).toBeNull();
    expect(
      anchorFraction({ x: 0, y: 0 }, { left: 0, top: 0, width: Number.NaN, height: 10 })
    ).toBeNull();
  });
});

describe('nearestBoxIndex', () => {
  const boxes = [
    { top: 0, height: 100 },
    { top: 120, height: 100 },
    { top: 240, height: 100 },
  ];

  it.each([
    [50, 0],
    [0, 0],
    [100, 0],
    [150, 1],
    [300, 2],
  ])('finds the box containing %s', (y, expected) => {
    expect(nearestBoxIndex(y, boxes)).toBe(expected);
  });

  it('falls on the nearest page when the pinch lands in a gutter', () => {
    expect(nearestBoxIndex(105, boxes)).toBe(0);
    expect(nearestBoxIndex(118, boxes)).toBe(1);
  });

  it('clamps past either end, and reports -1 for an empty document', () => {
    expect(nearestBoxIndex(-500, boxes)).toBe(0);
    expect(nearestBoxIndex(9999, boxes)).toBe(2);
    expect(nearestBoxIndex(10, [])).toBe(-1);
  });
});

describe('nearestStepIndex', () => {
  const steps = [1, 1.5, 2, 3];

  it.each([
    [1, 0],
    [1.2, 0],
    [1.4, 1],
    [1.9, 2],
    [2.6, 3],
    [9, 3],
    [0.1, 0],
  ])('settles %s on index %s', (value, expected) => {
    expect(nearestStepIndex(value, steps)).toBe(expected);
  });

  it('breaks a tie towards the LOWER step, never the more expensive render', () => {
    // 1.25 is equidistant from 1 and 1.5.
    expect(nearestStepIndex(1.25, steps)).toBe(0);
  });

  it('survives an empty ladder', () => {
    expect(nearestStepIndex(2, [])).toBe(0);
  });
});

describe('touch geometry', () => {
  it('reads the midpoint and the distance of two points', () => {
    const a = { clientX: 0, clientY: 0 };
    const b = { clientX: 30, clientY: 40 };
    expect(touchMidpoint(a, b)).toEqual({ x: 15, y: 20 });
    expect(touchDistance(a, b)).toBe(50);
  });
});
