/**
 * The media viewer's gesture maths (`src/lib/utils/viewerGestures.ts`), ported from MiGallery's
 * viewer with its tests.
 *
 * Pure functions, no server needed. What this pins is the part a device test cannot measure
 * repeatably: which gesture a touch sequence is, and when a released swipe commits or springs back.
 */

import { describe, it, expect } from 'vitest';
import {
  GESTURE,
  classifyMove,
  isTap,
  isDoubleTap,
  releaseVelocity,
  dragOffset,
  decideSwipe,
  decideDismiss,
  dismissProgress,
  dismissScale,
} from '$lib/utils/viewerGestures';

const sample = (x: number, y: number, t: number) => ({ x, y, t });

describe('classifyMove', () => {
  it('stays pending inside the tap slop', () => {
    expect(classifyMove({ dx: 5, dy: 5, zoomed: false, touches: 1 })).toBe('pending');
  });

  it('reads a mostly horizontal drag as a horizontal swipe, either way', () => {
    expect(classifyMove({ dx: -40, dy: 10, zoomed: false, touches: 1 })).toBe('swipe-h');
    expect(classifyMove({ dx: 40, dy: -10, zoomed: false, touches: 1 })).toBe('swipe-h');
  });

  it('separates a downward drag (close) from an upward one', () => {
    expect(classifyMove({ dx: 5, dy: 40, zoomed: false, touches: 1 })).toBe('swipe-down');
    expect(classifyMove({ dx: 5, dy: -40, zoomed: false, touches: 1 })).toBe('swipe-up');
  });

  it('pans instead of swiping when the photo is zoomed', () => {
    expect(classifyMove({ dx: -80, dy: 0, zoomed: true, touches: 1 })).toBe('pan');
    expect(classifyMove({ dx: 0, dy: 80, zoomed: true, touches: 1 })).toBe('pan');
  });

  it('calls two fingers a pinch whatever they moved', () => {
    expect(classifyMove({ dx: 0, dy: 0, zoomed: false, touches: 2 })).toBe('pinch');
  });
});

describe('taps', () => {
  it('accepts a short still press as a tap and refuses a long or moving one', () => {
    expect(isTap(sample(100, 100, 0), sample(103, 102, 120))).toBe(true);
    expect(isTap(sample(100, 100, 0), sample(100, 100, GESTURE.TAP_MAX_MS + 1))).toBe(false);
    expect(isTap(sample(100, 100, 0), sample(130, 100, 100))).toBe(false);
  });

  it('pairs two taps close in time and space into a double-tap', () => {
    expect(isDoubleTap(null, sample(100, 100, 0))).toBe(false);
    expect(isDoubleTap(sample(100, 100, 0), sample(110, 105, 200))).toBe(true);
    expect(isDoubleTap(sample(100, 100, 0), sample(110, 105, GESTURE.DOUBLE_TAP_MS + 1))).toBe(
      false
    );
    expect(isDoubleTap(sample(100, 100, 0), sample(300, 100, 100))).toBe(false);
  });
});

describe('releaseVelocity', () => {
  it('is zero without two samples or without elapsed time', () => {
    expect(releaseVelocity([])).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([sample(0, 0, 10), sample(50, 0, 10)])).toEqual({ x: 0, y: 0 });
  });

  it('measures only the last window, so a slow drag ended by a flick reads as the flick', () => {
    const samples = [
      sample(0, 0, 0),
      sample(10, 0, 500),
      sample(20, 0, 1000),
      sample(60, 0, 1050),
      sample(100, 0, 1100),
    ];
    // Window = last 100 ms: from (20, 1000) to (100, 1100) -> 0.8 px/ms.
    expect(releaseVelocity(samples).x).toBeCloseTo(0.8);
  });
});

describe('horizontal swipe', () => {
  const base = { width: 400, hasPrevious: true, hasNext: true };

  it('follows the finger towards a neighbour and resists past the ends', () => {
    expect(dragOffset(-100, true, true)).toBe(-100);
    expect(dragOffset(-100, true, false)).toBeCloseTo(-100 * GESTURE.EDGE_RESISTANCE);
    expect(dragOffset(100, false, true)).toBeCloseTo(100 * GESTURE.EDGE_RESISTANCE);
  });

  it('commits past a quarter of the width, left = next, right = previous', () => {
    expect(decideSwipe({ ...base, dx: -120, velocityX: 0 })).toBe('next');
    expect(decideSwipe({ ...base, dx: 120, velocityX: 0 })).toBe('previous');
    expect(decideSwipe({ ...base, dx: -60, velocityX: 0 })).toBe('stay');
  });

  it('commits a short flick, but not one flicked back against the drag', () => {
    expect(decideSwipe({ ...base, dx: -40, velocityX: -0.6 })).toBe('next');
    expect(decideSwipe({ ...base, dx: -40, velocityX: 0.6 })).toBe('stay');
    expect(decideSwipe({ ...base, dx: -10, velocityX: -2 })).toBe('stay');
  });

  it('never commits towards a missing neighbour', () => {
    expect(decideSwipe({ ...base, hasNext: false, dx: -300, velocityX: -2 })).toBe('stay');
    expect(decideSwipe({ ...base, hasPrevious: false, dx: 300, velocityX: 2 })).toBe('stay');
  });
});

describe('swipe down to close', () => {
  it('closes past a fifth of the height or on a downward flick, springs back otherwise', () => {
    expect(decideDismiss({ dy: 200, velocityY: 0, height: 800 })).toBe(true);
    expect(decideDismiss({ dy: 100, velocityY: 0, height: 800 })).toBe(false);
    expect(decideDismiss({ dy: 60, velocityY: 0.8, height: 800 })).toBe(true);
    expect(decideDismiss({ dy: -200, velocityY: 2, height: 800 })).toBe(false);
  });

  it('fades and shrinks in proportion to the drag, bounded', () => {
    expect(dismissProgress(0, 800)).toBe(0);
    expect(dismissProgress(200, 800)).toBeCloseTo(0.5);
    expect(dismissProgress(2000, 800)).toBe(1);
    expect(dismissScale(0)).toBe(1);
    expect(dismissScale(1)).toBeCloseTo(1 - GESTURE.DISMISS_SHRINK);
  });
});
