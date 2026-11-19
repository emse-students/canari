import { describe, expect, it } from 'vitest';
import { computeSnapshot, type ViewportMeasurement } from './keyboardViewport.svelte';
import { parseImeTarget, resolveImeTarget, type ImeTarget } from './imeTarget';

// Mi 9T, LatinIME, 2026-11-13: a 945 CSS px viewport and a 357.98 CSS px keyboard (886 px / 2.475).
const baseline = 945;
const kb = 357.98;
const ANDROID_THRESHOLD = 160;

function measure(overrides: Partial<ViewportMeasurement> = {}): ViewportMeasurement {
  return { winH: baseline, vvHeight: baseline, offsetTop: 0, scale: 1, ...overrides };
}

const handoff = (px: number): ImeTarget => ({ kind: 'handoff', px });
const overlay = (px: number): ImeTarget => ({ kind: 'overlay', px, animation: null });

/** The Android shell's 24 samples of `PathInterpolator(0.2, 0, 0, 1)`, rounded as it sends them. */
const SYNCED_CURVE = Array.from({ length: 24 }, (_, i) => Math.round((i / 23) ** 0.3 * 1e4) / 1e4);

describe('resolveImeTarget - an iOS hand-off (a bare number)', () => {
  it('reads the real measurement when nothing was announced', () => {
    const m = measure();
    expect(resolveImeTarget(m, baseline, null)).toEqual({ measurement: m, drop: false });
  });

  it('lays the page out as the resize will, before the resize', () => {
    const { measurement, drop } = resolveImeTarget(measure(), baseline, handoff(kb));
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
    expect(ahead.occlusionBottom).toBe(0);
    expect(Math.abs(ahead.keyboardHeight - after.keyboardHeight)).toBeLessThanOrEqual(1);
  });

  it('is spent once the resize has shrunk the layout viewport', () => {
    const m = measure({ winH: 588, vvHeight: 587.9 });
    expect(resolveImeTarget(m, baseline, handoff(kb))).toEqual({ measurement: m, drop: true });
  });

  it('is spent once the WebView has shrunk its visual viewport by itself', () => {
    const m = measure({ vvHeight: 588 });
    expect(resolveImeTarget(m, baseline, handoff(kb))).toEqual({ measurement: m, drop: true });
  });

  it('is spent by an announced 0: the keyboard fell before the resize landed', () => {
    const m = measure();
    expect(resolveImeTarget(m, baseline, handoff(0))).toEqual({ measurement: m, drop: true });
  });

  it('keeps a pinch-zoom visible to the snapshot, which then bails out as for a real zoom', () => {
    const { measurement } = resolveImeTarget(measure({ scale: 2 }), baseline, handoff(kb));
    expect(computeSnapshot(measurement, baseline, ANDROID_THRESHOLD).zoomed).toBe(true);
  });
});

describe('resolveImeTarget - an Android overlay (an object): the shell is the one source', () => {
  it('keeps the layout at the window height and the keyboard over it', () => {
    const { measurement, drop } = resolveImeTarget(measure(), baseline, overlay(kb));
    expect(drop).toBe(false);
    expect(measurement).toEqual({
      winH: baseline,
      vvHeight: baseline - kb,
      offsetTop: 0,
      scale: 1,
      overlayPx: kb,
    });
  });

  it('is never spent by the viewport: what the WebView reports of itself is not read', () => {
    for (const raw of [
      measure({ vvHeight: 588 }),
      measure({ winH: 588, vvHeight: 587.9 }),
      measure({ vvHeight: 230, offsetTop: 40 }),
    ]) {
      const { measurement, drop } = resolveImeTarget(raw, baseline, overlay(kb));
      expect(drop).toBe(false);
      expect(measurement.overlayPx).toBe(kb);
      expect(measurement.winH).toBe(raw.winH);
      expect(measurement.vvHeight).toBe(raw.winH - kb);
      expect(measurement.offsetTop).toBe(0);
    }
  });

  it('follows a window made shorter than the baseline: split screen, freeform, a fold (F1)', () => {
    // The baseline only grows: 945 from the full-screen start. The window is now 450 tall - the
    // WebView was resized for a reason that is not the keyboard, and `innerHeight` says so.
    const { measurement } = resolveImeTarget(
      measure({ winH: 450, vvHeight: 450 }),
      baseline,
      overlay(kb)
    );
    expect(measurement.winH).toBe(450);
    expect(measurement.vvHeight).toBeCloseTo(450 - kb, 6);
    const snapshot = computeSnapshot(measurement, baseline, ANDROID_THRESHOLD);
    // The shell is the window, never the 945 px it once was.
    expect(snapshot.shellHeight).toBe(450);
    expect(snapshot.occlusionBottom).toBe(kb);
    // Closed in the same window: the shell is still the window.
    const closed = resolveImeTarget(measure({ winH: 450, vvHeight: 450 }), baseline, overlay(0));
    expect(computeSnapshot(closed.measurement, baseline, ANDROID_THRESHOLD).shellHeight).toBe(450);
  });

  it('holds 0 as an answer too: no keyboard, whatever the visual viewport says', () => {
    const { measurement, drop } = resolveImeTarget(
      measure({ vvHeight: 588 }),
      baseline,
      overlay(0)
    );
    expect(drop).toBe(false);
    expect(measurement).toEqual({
      winH: baseline,
      vvHeight: baseline,
      offsetTop: 0,
      scale: 1,
      overlayPx: 0,
    });
  });

  it('never covers more than the window', () => {
    expect(resolveImeTarget(measure(), baseline, overlay(2000)).measurement.vvHeight).toBe(0);
  });
});

describe('parseImeTarget', () => {
  it("takes a finite non-negative number as iOS's hand-off", () => {
    expect(parseImeTarget(357.98)).toEqual({ kind: 'handoff', px: 357.98 });
    expect(parseImeTarget(0)).toEqual({ kind: 'handoff', px: 0 });
  });

  it("takes Android's announcement with no animation", () => {
    expect(parseImeTarget({ px: 357.98 })).toEqual({
      kind: 'overlay',
      px: 357.98,
      animation: null,
    });
    expect(parseImeTarget({ px: 0 })).toEqual({ kind: 'overlay', px: 0, animation: null });
  });

  it("takes Android's animated announcement and builds the easing from its numbers", () => {
    const target = parseImeTarget({ px: kb, durationMs: 285, curve: SYNCED_CURVE });
    expect(target).toEqual({
      kind: 'overlay',
      px: kb,
      animation: { durationMs: 285, easing: `linear(${SYNCED_CURVE.join(', ')})` },
    });
  });

  it('refuses anything else, half an animation included', () => {
    for (const v of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '357',
      null,
      undefined,
      {},
      { px: -1 },
      { px: '357' },
      { px: kb, durationMs: 285 },
      { px: kb, curve: [0, 1] },
      { px: kb, durationMs: -1, curve: [0, 1] },
      { px: kb, durationMs: Number.NaN, curve: [0, 1] },
      { px: kb, durationMs: 285, curve: [0] },
      { px: kb, durationMs: 285, curve: Array(65).fill(0.5) },
      { px: kb, durationMs: 285, curve: [0, Number.NaN, 1] },
      { px: kb, durationMs: 285, curve: 'cubic-bezier(0.2, 0, 0, 1)' },
    ]) {
      expect(parseImeTarget(v)).toBeNull();
    }
  });
});
