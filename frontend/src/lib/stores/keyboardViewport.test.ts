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

  it('leaves no band below the shell once the native layer resizes (iOS keyboard)', () => {
    // THE GEOMETRY THAT WAS WRONG ON iOS, and the one property that separates the two worlds.
    // WKWebView is not resized for the keyboard on its own: `winH` stays full while only the
    // visual viewport shrinks, so the shell gets pinned to 480 inside a document still 800 tall
    // and a keyboard-tall empty band opens below it - which WebKit then scrolls onto when it
    // reveals the focused field. Both worlds report `layoutInsetBottom: 0`, so that field cannot
    // tell them apart; what can is whether the shell height IS the layout viewport.
    const withoutNativeResize = computeSnapshot(
      measure({ vvHeight: 480 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(withoutNativeResize.isOpen).toBe(true);
    expect(withoutNativeResize.viewportHeight).toBeLessThan(800); // shell 480, document 800

    // With canari_ios.mm's CanariApplyKeyboardLayout shrinking the WebView, the layout viewport
    // itself moves, so the two agree and the band cannot exist.
    const withNativeResize = computeSnapshot(
      measure({ winH: 480, vvHeight: 480 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(withNativeResize.viewportHeight).toBe(480);
    expect(withNativeResize.insetBottom).toBe(0);
    expect(withNativeResize.layoutInsetBottom).toBe(0);
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
