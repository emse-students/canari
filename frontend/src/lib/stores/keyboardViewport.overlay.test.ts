import { describe, expect, it } from 'vitest';
import {
  computeSnapshot,
  isDoubleReport,
  keyboardFreeViewportHeight,
  keyboardInsetBottom,
  keyboardMoved,
  keyboardRevealOnUpdate,
  type ViewportMeasurement,
} from './keyboardViewport.svelte';

/**
 * THE KEYBOARD'S VARIABLES, ONE MODULE FOR EVERY PLATFORM (keyboard ride, 2026-11-14).
 *
 * The Android app's keyboard now covers the WebView without resizing it (`overlayPx`); the web and
 * iOS keep measuring theirs from the viewport. The first block proves that NOTHING they compute
 * moved: `computeSnapshot` as it stood before the change is kept below, verbatim in its arithmetic,
 * as the oracle, and every measurement shape the existing suites use - plus a grid around them - must
 * give the same snapshot, with the two new fields at the values that leave the CSS unchanged
 * (`occlusionBottom` 0, `shellHeight` the old `viewportHeight` that `--app-viewport-height` read).
 */

type OldSnapshot = {
  isOpen: boolean;
  viewportHeight: number;
  offsetTop: number;
  insetBottom: number;
  layoutInsetBottom: number;
  zoomed: boolean;
  keyboardHeight: number;
};

/** `computeSnapshot` before the overlay existed (main at 97f017767), its arithmetic unchanged. */
function computeSnapshotBefore(
  m: ViewportMeasurement,
  baselineHeight: number,
  thresholdPx: number
): OldSnapshot {
  if (m.scale > 1.01) {
    return {
      isOpen: false,
      viewportHeight: baselineHeight,
      offsetTop: 0,
      insetBottom: 0,
      layoutInsetBottom: 0,
      zoomed: true,
      keyboardHeight: 0,
    };
  }
  const vvHeight = isDoubleReport(m, baselineHeight) ? m.winH : m.vvHeight;
  const insetBottom = Math.max(0, m.winH - vvHeight - m.offsetTop);
  const delta = Math.max(baselineHeight - vvHeight, m.winH - vvHeight);
  const isOpen = delta > thresholdPx;
  const layoutShrunk =
    baselineHeight - m.winH > thresholdPx * 0.35 || m.winH - vvHeight > thresholdPx * 0.35;
  return {
    isOpen,
    viewportHeight: vvHeight,
    offsetTop: m.offsetTop,
    insetBottom,
    layoutInsetBottom: isOpen && !layoutShrunk ? insetBottom : 0,
    zoomed: false,
    keyboardHeight: isOpen ? Math.max(0, Math.round(baselineHeight - vvHeight)) : 0,
  };
}

/** Every measurement shape `keyboardViewport.test.ts` and `imeTarget.test.ts` read, by platform. */
const MEASURED: { what: string; m: ViewportMeasurement; baseline: number; threshold: number }[] = [
  {
    what: 'at rest',
    m: { winH: 800, vvHeight: 800, offsetTop: 0, scale: 1 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'iOS, WebView resized',
    m: { winH: 480, vvHeight: 480, offsetTop: 0, scale: 1 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'iOS, iPhone 12 overlap 301',
    m: { winH: 543, vvHeight: 543, offsetTop: 0, scale: 1 },
    baseline: 844,
    threshold: 100,
  },
  {
    what: 'phone browser, visual only',
    m: { winH: 800, vvHeight: 464, offsetTop: 0, scale: 1 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'a pan',
    m: { winH: 800, vvHeight: 500, offsetTop: 120, scale: 1 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'a pinch-zoom',
    m: { winH: 800, vvHeight: 400, offsetTop: 0, scale: 2 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'a scale barely above 1',
    m: { winH: 800, vvHeight: 800, offsetTop: 0, scale: 1.005 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'a URL bar',
    m: { winH: 744, vvHeight: 744, offsetTop: 0, scale: 1 },
    baseline: 800,
    threshold: 100,
  },
  {
    what: 'Android padded, settled',
    m: { winH: 588, vvHeight: 587.9, offsetTop: 0, scale: 1 },
    baseline: 945,
    threshold: 160,
  },
  {
    what: 'Android double report',
    m: { winH: 588, vvHeight: 230.3, offsetTop: 0, scale: 1 },
    baseline: 945,
    threshold: 160,
  },
  {
    what: 'Android visual first',
    m: { winH: 945, vvHeight: 588, offsetTop: 0, scale: 1 },
    baseline: 945,
    threshold: 160,
  },
  {
    what: 'Android 90 px keyboard, doubled',
    m: { winH: 702, vvHeight: 612, offsetTop: 0, scale: 1 },
    baseline: 792,
    threshold: 160,
  },
];

describe('the web and iOS compute exactly what they computed before', () => {
  it('gives the same snapshot for every measurement the suites hold, and 0 for the new inset', () => {
    for (const { what, m, baseline, threshold } of MEASURED) {
      const before = computeSnapshotBefore(m, baseline, threshold);
      expect(computeSnapshot(m, baseline, threshold), what).toEqual({
        ...before,
        occlusionBottom: 0,
        shellHeight: before.viewportHeight,
      });
    }
  });

  it('gives the same snapshot over a grid of every shape around them', () => {
    let checked = 0;
    for (const baseline of [800, 844, 945])
      for (const winH of [baseline, baseline - 1, baseline - 56, baseline - 301, baseline - 358])
        for (const vvHeight of [winH, winH - 1, winH - 90, winH - 301, winH - 358, 230.3])
          for (const offsetTop of [0, 40])
            for (const scale of [1, 1.005, 2])
              for (const threshold of [100, 160]) {
                const m = { winH, vvHeight, offsetTop, scale };
                const before = computeSnapshotBefore(m, baseline, threshold);
                expect(computeSnapshot(m, baseline, threshold)).toEqual({
                  ...before,
                  occlusionBottom: 0,
                  shellHeight: before.viewportHeight,
                });
                // The layout inset was 0 on every one of them, and still is: no CSS rule that adds
                // it, or the new occlusion, moves on the web or iOS.
                expect(before.layoutInsetBottom).toBe(0);
                checked++;
              }
    expect(checked).toBe(1080);
  });
});

describe('an overlay keyboard (the Android app): the shell keeps its height, the insets carry the room', () => {
  // Mi 9T, LatinIME, 2026-11-13: a 945 CSS px window and a 357.98 CSS px keyboard.
  const baseline = 945;
  const kb = 357.98;
  const over = (px: number, scale = 1): ViewportMeasurement => ({
    winH: baseline,
    vvHeight: baseline - px,
    offsetTop: 0,
    scale,
    overlayPx: px,
  });

  it('opens with the full shell and the keyboard in both insets', () => {
    expect(computeSnapshot(over(kb), baseline, 160)).toEqual({
      isOpen: true,
      viewportHeight: baseline - kb,
      offsetTop: 0,
      insetBottom: kb,
      layoutInsetBottom: kb,
      occlusionBottom: kb,
      shellHeight: baseline,
      zoomed: false,
      keyboardHeight: 358,
    });
  });

  it('lifts what sits on a keyboard shorter than the threshold, without calling it open', () => {
    const snap = computeSnapshot(over(90), baseline, 160);
    expect(snap.isOpen).toBe(false);
    expect(snap.keyboardHeight).toBe(0);
    expect(snap.layoutInsetBottom).toBe(90);
    expect(snap.occlusionBottom).toBe(90);
  });

  it('is closed with no inset at 0', () => {
    const snap = computeSnapshot(over(0), baseline, 160);
    expect(snap.isOpen).toBe(false);
    expect(snap.layoutInsetBottom).toBe(0);
    expect(snap.occlusionBottom).toBe(0);
    expect(snap.shellHeight).toBe(baseline);
  });

  it('keeps the keyboard under a pinch-zoom: the shell said where it is', () => {
    const snap = computeSnapshot(over(kb, 2), baseline, 160);
    expect(snap.zoomed).toBe(true);
    expect(snap.isOpen).toBe(true);
    expect(snap.occlusionBottom).toBe(kb);
  });

  it('gives the composer GIF panel the window height back (viewport + keyboard)', () => {
    const snap = computeSnapshot(over(kb), baseline, 160);
    // `ChatComposer` sizes the panel from `viewportHeight + keyboardHeight`: the whole window.
    expect(Math.abs(snap.viewportHeight + snap.keyboardHeight - baseline)).toBeLessThanOrEqual(1);
  });

  it('is the band a fixed popover keeps out of, and holds no media at a keyboard-free height', () => {
    expect(keyboardInsetBottom(over(kb), baseline)).toBe(kb);
    // The layout is the baseline: `svh` is already the keyboard-free height.
    expect(keyboardFreeViewportHeight(true, over(kb).winH, baseline)).toBeNull();
  });
});

/**
 * The reveal before N3 (main at 97f017767): a later update with the keyboard up and a field focused
 * revealed `smooth`, whatever the update changed.
 */
function revealBefore(isOpen: boolean, hasFocus: boolean): ScrollBehavior | null {
  return isOpen && hasFocus ? 'smooth' : null;
}

describe('the web and iOS reveal exactly what they revealed before, unless nothing moved (second review of #3556)', () => {
  it('a later update between any two web or iOS shapes reveals as before whenever the keyboard moved', () => {
    let changed = 0;
    for (const a of MEASURED)
      for (const b of MEASURED) {
        if (a.baseline !== b.baseline || a.threshold !== b.threshold) continue;
        const before = computeSnapshot(a.m, a.baseline, a.threshold);
        const after = computeSnapshot(b.m, b.baseline, b.threshold);
        // The opening and the hand-off reveal `auto` on both sides; the later update is the question.
        if (after.isOpen && !before.isOpen) continue;
        const visible =
          before.viewportHeight !== after.viewportHeight ||
          before.insetBottom !== after.insetBottom;
        const now = keyboardRevealOnUpdate({
          covers: after.isOpen,
          openedNow: false,
          targetSpent: false,
          hasFocus: true,
          keyboardMoved: keyboardMoved(before, after),
        });
        // The N3 change, and only it: an update that moved nothing a reader sees reveals nothing.
        expect(now, `${a.what} -> ${b.what}`).toBe(
          visible ? revealBefore(after.isOpen, true) : null
        );
        if (visible && after.isOpen) changed++;
      }
    expect(changed).toBeGreaterThan(0);
  });

  it('an iOS keyboard growing while open moves only the visible height, and that is a move', () => {
    // iPhone 12: the 301 px keyboard, then the emoji keyboard ~40 px taller - the WebView resized.
    const before = computeSnapshot({ winH: 543, vvHeight: 543, offsetTop: 0, scale: 1 }, 844, 100);
    const after = computeSnapshot({ winH: 503, vvHeight: 503, offsetTop: 0, scale: 1 }, 844, 100);
    expect([before.insetBottom, after.insetBottom]).toEqual([0, 0]);
    expect(keyboardMoved(before, after)).toBe(true);
  });
});
