import { describe, it, expect } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampView,
  fitView,
  glideStep,
  minScaleFor,
  releaseVelocity,
  zoomAt,
} from './view';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

describe('fitView', () => {
  it('scales a small board UP to fill a big screen, centred', () => {
    const v = fitView({ width: 800, height: 600 }, { width: 200, height: 100 }, NO_INSETS);
    expect(v.scale).toBe(MAX_SCALE);
    expect(v.panX).toBeCloseTo((800 - 200 * v.scale) / 2);
    expect(v.panY).toBeCloseTo((600 - 100 * v.scale) / 2);
  });

  it('scales a big board down so it fits the padded area, the limiting axis winning', () => {
    const v = fitView(
      { width: 400, height: 800 },
      { width: 600, height: 1000 },
      { top: 50, right: 10, bottom: 70, left: 10 }
    );
    expect(v.scale).toBeCloseTo(Math.min(380 / 600, 680 / 1000));
    expect(v.panX).toBeCloseTo(10 + (380 - 600 * v.scale) / 2);
  });

  it('keeps the board out of the reserved top and bottom bands', () => {
    const insets = { top: 60, right: 0, bottom: 90, left: 0 };
    const v = fitView({ width: 1000, height: 700 }, { width: 100, height: 800 }, insets);
    expect(v.panY).toBeGreaterThanOrEqual(insets.top - 1e-9);
    expect(v.panY + 800 * v.scale).toBeLessThanOrEqual(700 - insets.bottom + 1e-9);
  });

  it('answers the identity for an empty board instead of dividing by zero', () => {
    expect(fitView({ width: 100, height: 100 }, { width: 0, height: 0 }, NO_INSETS)).toEqual({
      scale: 1,
      panX: 0,
      panY: 0,
    });
  });
});

describe('clampView', () => {
  const viewport = { width: 400, height: 800 };
  const board = { width: 600, height: 1000 };

  it('cannot drag a larger board further than the margin past its edges', () => {
    const far = clampView({ scale: 1, panX: 500, panY: -9000 }, viewport, board, 48);
    expect(far.panX).toBe(48);
    expect(far.panY).toBe(800 - 1000 - 48);
  });

  it('centres a board smaller than the viewport on that axis, wherever it was dropped', () => {
    const v = clampView({ scale: 0.5, panX: -300, panY: 700 }, viewport, board, 48);
    expect(v.panX).toBe((400 - 300) / 2);
    expect(v.panY).toBe((800 - 500) / 2);
  });

  it('leaves a reachable position untouched', () => {
    const v = { scale: 1, panX: -100, panY: -100 };
    expect(clampView(v, viewport, board, 48)).toEqual(v);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the finger fixed', () => {
    const v = zoomAt({ scale: 1, panX: 10, panY: 20 }, 100, 120, 2, MIN_SCALE);
    expect((100 - v.panX) / v.scale).toBeCloseTo((100 - 10) / 1);
    expect((120 - v.panY) / v.scale).toBeCloseTo((120 - 20) / 1);
  });

  it('clamps to the bounds, with the lower one relaxed on a small screen', () => {
    expect(zoomAt({ scale: 1, panX: 0, panY: 0 }, 0, 0, 99, MIN_SCALE).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 1, panX: 0, panY: 0 }, 0, 0, 0.01, 0.25).scale).toBe(0.25);
    expect(minScaleFor(0.25)).toBe(0.25);
    expect(minScaleFor(0.9)).toBe(MIN_SCALE);
  });
});

describe('flick', () => {
  it('reads the speed of the last 100 ms of a drag', () => {
    const { vx, vy } = releaseVelocity(
      [
        { t: 0, x: 0, y: 0 },
        { t: 950, x: 100, y: 0 },
        { t: 1000, x: 150, y: 10 },
      ],
      1010
    );
    expect(vx).toBeCloseTo(1);
    expect(vy).toBeCloseTo(0.2);
  });

  it('is zero when the finger rested before lifting, or barely moved', () => {
    expect(
      releaseVelocity(
        [
          { t: 0, x: 0, y: 0 },
          { t: 50, x: 90, y: 0 },
        ],
        600
      )
    ).toEqual({
      vx: 0,
      vy: 0,
    });
    expect(
      releaseVelocity(
        [
          { t: 0, x: 0, y: 0 },
          { t: 90, x: 3, y: 0 },
        ],
        95
      )
    ).toEqual({ vx: 0, vy: 0 });
  });

  it('glides, slows down and ends instead of crawling for ever', () => {
    let vx = 2;
    let travelled = 0;
    let frames = 0;
    while (vx !== 0 && frames < 1000) {
      const s = glideStep(vx, 0, 16);
      travelled += s.dx;
      vx = s.vx;
      frames++;
    }
    expect(vx).toBe(0);
    expect(frames).toBeLessThan(1000);
    expect(travelled).toBeGreaterThan(0);
  });
});
