import { describe, expect, it } from 'vitest';
import {
  REEL_FRAME_RATIO,
  containFrame,
  frameToPixels,
  pixelsToFrame,
  stableStageSize,
} from './reelFrame';

describe('stable stage', () => {
  const full = { width: 400, height: 800 };

  it('keeps the full height when the keyboard shrinks the box', () => {
    expect(stableStageSize(full, { width: 400, height: 480 })).toEqual(full);
  });

  it('grows when the first measure was short, takes a new width whole, ignores an empty measure', () => {
    expect(stableStageSize({ width: 400, height: 480 }, full)).toEqual(full);
    expect(stableStageSize(full, { width: 800, height: 400 })).toEqual({ width: 800, height: 400 });
    expect(stableStageSize(full, { width: 0, height: 0 })).toEqual(full);
  });
});

describe('contained frame', () => {
  const R = REEL_FRAME_RATIO;

  it('is edge to edge, square-cornered, on a 9:16 screen', () => {
    const box = containFrame({ width: 360, height: 640 }, R);
    expect(box).toMatchObject({ left: 0, top: 0, width: 360, height: 640, fillsStage: true });
  });

  it('shows the whole frame, centred, with bands above and below on a 20:9 phone', () => {
    const box = containFrame({ width: 360, height: 800 }, R);
    expect(box.width).toBe(360);
    expect(box.height).toBe(640);
    expect(box.top).toBe(80);
    expect(box.left).toBe(0);
    expect(box.fillsStage).toBe(false);
  });

  it('puts the bands at the sides on a 4:3 tablet and a landscape desktop', () => {
    const tablet = containFrame({ width: 768, height: 1024 }, R);
    expect(tablet.height).toBe(1024);
    expect(tablet.width).toBeCloseTo(576);
    expect(tablet.left).toBeCloseTo(96);
    expect(tablet.fillsStage).toBe(false);
    const desktop = containFrame({ width: 1920, height: 1080 }, R);
    expect(desktop.height).toBe(1080);
    expect(desktop.width).toBeCloseTo(607.5);
    expect(desktop.left).toBeCloseTo(656.25);
    expect(desktop.fillsStage).toBe(false);
  });

  it('never exceeds the stage, whatever the media ratio', () => {
    for (const ratio of [0.2, 9 / 16, 1, 4 / 3, 3]) {
      const box = containFrame({ width: 390, height: 844 }, ratio);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(390 + 1e-9);
      expect(box.top + box.height).toBeLessThanOrEqual(844 + 1e-9);
      expect(box.width / box.height).toBeCloseTo(ratio);
    }
  });

  it('answers nothing before the stage is measured', () => {
    expect(containFrame({ width: 0, height: 0 }, R).width).toBe(0);
  });
});

describe('overlay coordinates', () => {
  it('round-trip between the preview frame and the exported media', () => {
    const point = { x: 0.37, y: 0.82 };
    const preview = { width: 360, height: 640 };
    const exported = { width: 720, height: 1280 };
    const onScreen = frameToPixels(point, preview);
    expect(pixelsToFrame(onScreen, preview).x).toBeCloseTo(point.x);
    expect(pixelsToFrame(onScreen, preview).y).toBeCloseTo(point.y);
    const inExport = frameToPixels(pixelsToFrame(onScreen, preview), exported);
    expect(inExport.x / exported.width).toBeCloseTo(onScreen.x / preview.width);
    expect(inExport.y / exported.height).toBeCloseTo(onScreen.y / preview.height);
  });

  it('is the same share of the frame on a differently shaped screen', () => {
    const a = containFrame({ width: 360, height: 640 }, REEL_FRAME_RATIO);
    const b = containFrame({ width: 360, height: 800 }, REEL_FRAME_RATIO);
    const point = { x: 0.5, y: 0.9 };
    expect(frameToPixels(point, a).y / a.height).toBeCloseTo(frameToPixels(point, b).y / b.height);
  });
});
