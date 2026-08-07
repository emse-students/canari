import { focalScroll, nearestStepIndex, touchDistance, touchMidpoint } from './pinchZoom';

describe('focalScroll', () => {
  it('keeps the point under the fingers under the fingers - the whole defect', () => {
    // Reported on device 2026-08-07: "pincher augmente le zoom, mais ca augmente pas a l'endroit
    // qu'on veut". The PDF column was `origin-top` with no scroll correction, so the content the
    // user pinched drifted away as the column widened.
    // Content point under the focal: (0 + 200) / 1 = 200. At scale 3 it sits at 600, so the
    // scroll must be 600 - 200 = 400 for it to land back under the finger.
    expect(
      focalScroll({ scrollLeft: 0, scrollTop: 0, focalX: 200, focalY: 100, from: 1, to: 3 })
    ).toEqual({
      scrollLeft: 400,
      scrollTop: 200,
    });
  });

  it('accounts for the scroll already applied', () => {
    // Content under the focal: (300 + 100) / 2 = 200. At scale 4: 800, minus the focal = 700.
    expect(
      focalScroll({ scrollLeft: 300, scrollTop: 300, focalX: 100, focalY: 100, from: 2, to: 4 })
    ).toEqual({
      scrollLeft: 700,
      scrollTop: 700,
    });
  });

  it('zooms back out symmetrically', () => {
    const zoomedIn = focalScroll({
      scrollLeft: 0,
      scrollTop: 0,
      focalX: 200,
      focalY: 100,
      from: 1,
      to: 3,
    });
    const backOut = focalScroll({ ...zoomedIn, focalX: 200, focalY: 100, from: 3, to: 1 });
    expect(backOut).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it('never returns a negative scroll, which the DOM would clamp silently anyway', () => {
    const out = focalScroll({
      scrollLeft: 0,
      scrollTop: 0,
      focalX: 200,
      focalY: 200,
      from: 3,
      to: 1,
    });
    expect(out.scrollLeft).toBe(0);
    expect(out.scrollTop).toBe(0);
  });

  it('clamps to the caller-supplied maximum', () => {
    const out = focalScroll({
      scrollLeft: 0,
      scrollTop: 0,
      focalX: 200,
      focalY: 100,
      from: 1,
      to: 3,
      maxScrollLeft: 50,
      maxScrollTop: 25,
    });
    expect(out).toEqual({ scrollLeft: 50, scrollTop: 25 });
  });

  it('returns the offsets unchanged rather than NaN when the scale is unusable', () => {
    // A NaN assigned to `scrollLeft` is swallowed by the DOM, so this would fail invisibly.
    for (const from of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        focalScroll({ scrollLeft: 10, scrollTop: 20, focalX: 5, focalY: 5, from, to: 2 })
      ).toEqual({
        scrollLeft: 10,
        scrollTop: 20,
      });
    }
    expect(
      focalScroll({ scrollLeft: 10, scrollTop: 20, focalX: 5, focalY: 5, from: 1, to: 0 })
    ).toEqual({
      scrollLeft: 10,
      scrollTop: 20,
    });
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
