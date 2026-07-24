import { computeSnapshot, type ViewportMeasurement } from './keyboardViewport.svelte';

const IOS_THRESHOLD = 100;
const baseline = 800;

/** Builds a measurement with sensible defaults (at-rest, no keyboard, no zoom). */
function measure(overrides: Partial<ViewportMeasurement> = {}): ViewportMeasurement {
  return { winH: baseline, vvHeight: baseline, offsetTop: 0, scale: 1, ...overrides };
}

describe('computeSnapshot', () => {
  it('reports closed at rest', () => {
    const snap = computeSnapshot(measure(), baseline, IOS_THRESHOLD);
    expect(snap.isOpen).toBe(false);
    expect(snap.zoomed).toBe(false);
    expect(snap.viewportHeight).toBe(baseline);
    expect(snap.insetBottom).toBe(0);
  });

  it('detects an open keyboard when the visual viewport shrinks (adjustResize)', () => {
    // winH also shrank: adjustResize resized the layout viewport.
    const snap = computeSnapshot(measure({ winH: 480, vvHeight: 480 }), baseline, IOS_THRESHOLD);
    expect(snap.isOpen).toBe(true);
    expect(snap.zoomed).toBe(false);
    expect(snap.viewportHeight).toBe(480);
    // Layout shrank -> fixed UI needs no extra lift.
    expect(snap.layoutInsetBottom).toBe(0);
  });

  it('carries the pan offset through when the page is panned (adjustPan)', () => {
    // winH stays full, only the visual viewport shrinks and is offset (iOS adjustPan).
    const snap = computeSnapshot(
      measure({ vvHeight: 480, offsetTop: 40 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(snap.isOpen).toBe(true);
    expect(snap.insetBottom).toBe(280); // 800 - 480 - 40
    expect(snap.offsetTop).toBe(40);
  });

  it('root-cause guard: a pinch-zoom (scale > 1) is NOT a keyboard', () => {
    // Same shrink as a keyboard, but the user zoomed in. Must stay closed + full height.
    const snap = computeSnapshot(
      measure({ vvHeight: 480, offsetTop: 120, scale: 2.3 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(snap.zoomed).toBe(true);
    expect(snap.isOpen).toBe(false);
    // Shell height is left at the baseline (never collapsed onto the zoomed viewport).
    expect(snap.viewportHeight).toBe(baseline);
    expect(snap.offsetTop).toBe(0);
    expect(snap.insetBottom).toBe(0);
    expect(snap.layoutInsetBottom).toBe(0);
  });

  it('treats a scale barely above 1 as at rest, not zoomed', () => {
    const snap = computeSnapshot(measure({ scale: 1.005 }), baseline, IOS_THRESHOLD);
    expect(snap.zoomed).toBe(false);
  });
});
