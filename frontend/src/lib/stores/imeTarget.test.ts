import { describe, expect, it } from 'vitest';
import { computeSnapshot, type ViewportMeasurement } from './keyboardViewport.svelte';
import { parseImeTarget, resolveImeTarget } from './imeTarget';

// Mi 9T, LatinIME, 2026-11-13: a 945 CSS px viewport and a 357.98 CSS px keyboard (886 px / 2.475).
const baseline = 945;
const kb = 357.98;
const ANDROID_THRESHOLD = 160;

function measure(overrides: Partial<ViewportMeasurement> = {}): ViewportMeasurement {
  return { winH: baseline, vvHeight: baseline, offsetTop: 0, scale: 1, ...overrides };
}

describe('resolveImeTarget', () => {
  it('reads the real measurement when nothing was announced', () => {
    const m = measure();
    expect(resolveImeTarget(m, baseline, null)).toEqual({ measurement: m, drop: false });
  });

  it('lays the page out as the resize will, before the resize', () => {
    const { measurement, drop } = resolveImeTarget(measure(), baseline, kb);
    expect(drop).toBe(false);
    const ahead = computeSnapshot(measurement, baseline, ANDROID_THRESHOLD);
    // What the page measured after the real resize on the bench: innerHeight 588, visual 587.9.
    const after = computeSnapshot(
      measure({ winH: 588, vvHeight: 587.9 }),
      baseline,
      ANDROID_THRESHOLD
    );
    expect(ahead.isOpen).toBe(true);
    expect(after.isOpen).toBe(true);
    // Within the one CSS px of rounding `innerHeight` carries (945 is 945.45 rounded down; the
    // resized WebView is 587.47 tall, read as 588 and 587.9): the resize moves nothing visibly.
    expect(Math.abs(ahead.viewportHeight - after.viewportHeight)).toBeLessThanOrEqual(1);
    expect(ahead.layoutInsetBottom).toBe(after.layoutInsetBottom);
    expect(Math.abs(ahead.keyboardHeight - after.keyboardHeight)).toBeLessThanOrEqual(1);
  });

  it('is spent once the padding has resized the layout viewport', () => {
    const m = measure({ winH: 588, vvHeight: 587.9 });
    expect(resolveImeTarget(m, baseline, kb)).toEqual({ measurement: m, drop: true });
  });

  it('is spent once the WebView has shrunk its visual viewport by itself', () => {
    const m = measure({ vvHeight: 588 });
    expect(resolveImeTarget(m, baseline, kb)).toEqual({ measurement: m, drop: true });
  });

  it('is spent by an announced 0: the keyboard fell before the padding landed', () => {
    const m = measure();
    expect(resolveImeTarget(m, baseline, 0)).toEqual({ measurement: m, drop: true });
  });

  it('keeps a pinch-zoom visible to the snapshot, which then bails out as for a real zoom', () => {
    const { measurement } = resolveImeTarget(measure({ scale: 2 }), baseline, kb);
    expect(computeSnapshot(measurement, baseline, ANDROID_THRESHOLD).zoomed).toBe(true);
  });
});

describe('parseImeTarget', () => {
  it('takes a finite non-negative number', () => {
    expect(parseImeTarget(357.98)).toBe(357.98);
    expect(parseImeTarget(0)).toBe(0);
  });

  it('refuses anything else', () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY, '357', null, undefined, {}]) {
      expect(parseImeTarget(v)).toBeNull();
    }
  });
});
