import { describe, expect, it } from 'vitest';
import {
  MAX_OVERLAY_SCALE,
  MIN_OVERLAY_SCALE,
  TransformGesture,
  clampCentre,
  pointInRect,
  wrapAngle,
} from './transformGesture';

const START = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

function gesture() {
  const g = new TransformGesture(() => ({ width: 200, height: 400 }));
  g.begin(START);
  return g;
}

describe('TransformGesture', () => {
  it('moves the element by the finger, normalised to the stage size', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    const t = g.move(1, { x: 120, y: 160 })!;
    expect(t.x).toBeCloseTo(0.6);
    expect(t.y).toBeCloseTo(0.65);
    expect(t.scale).toBe(1);
    expect(t.rotation).toBe(0);
  });

  it('keeps the centre on the stage', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    const t = g.move(1, { x: 5000, y: -5000 })!;
    expect([t.x, t.y]).toEqual([1, 0]);
  });

  it('resizes with the ratio of the two fingers distance', () => {
    const g = gesture();
    g.down(1, { x: 80, y: 100 });
    g.down(2, { x: 120, y: 100 });
    const t = g.move(2, { x: 160, y: 100 })!; // distance 40 -> 80, centroid shifts by 20 px
    expect(t.scale).toBeCloseTo(2);
    expect(t.rotation).toBeCloseTo(0);
    expect(t.x).toBeCloseTo(0.5 + 20 / 200);
  });

  it('rotates with the twist of the two fingers', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    g.down(2, { x: 140, y: 100 });
    const t = g.move(2, { x: 100, y: 140 })!; // a quarter turn about finger 1
    expect(t.rotation).toBeCloseTo(Math.PI / 2);
    expect(t.scale).toBeCloseTo(1);
  });

  it('clamps the scale both ways', () => {
    const grow = gesture();
    grow.down(1, { x: 100, y: 100 });
    grow.down(2, { x: 101, y: 100 });
    expect(grow.move(2, { x: 1000, y: 100 })!.scale).toBe(MAX_OVERLAY_SCALE);
    const shrink = gesture();
    shrink.down(1, { x: 0, y: 100 });
    shrink.down(2, { x: 190, y: 100 });
    expect(shrink.move(2, { x: 1, y: 100 })!.scale).toBe(MIN_OVERLAY_SCALE);
  });

  it('does not jump when a second finger lands or the first one lifts', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    g.move(1, { x: 110, y: 100 });
    g.down(2, { x: 150, y: 100 });
    const landed = g.current;
    g.up(2);
    expect(g.current).toEqual(landed);
    // The remaining finger drags on from where it is.
    const t = g.move(1, { x: 120, y: 100 })!;
    expect(t.x).toBeCloseTo(landed.x + 10 / 200);
    expect(t.scale).toBe(landed.scale);
  });

  it('keeps turning past half a turn instead of wrapping back', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    g.down(2, { x: 140, y: 100 });
    let total = 0;
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 1.5; // 270 degrees
      g.move(2, { x: 100 + 40 * Math.cos(angle), y: 100 + 40 * Math.sin(angle) });
      total = g.current.rotation;
    }
    expect(total).toBeCloseTo(Math.PI * 1.5, 1);
  });

  it('ignores a third finger and a finger it does not track', () => {
    const g = gesture();
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 10, y: 0 });
    g.down(3, { x: 50, y: 50 });
    expect(g.pointerCount).toBe(2);
    expect(g.move(3, { x: 60, y: 60 })).toBeNull();
    expect(g.move(9, { x: 60, y: 60 })).toBeNull();
  });

  it('measures the travel, so a tap can be told from a drag', () => {
    const g = gesture();
    g.down(1, { x: 100, y: 100 });
    g.move(1, { x: 103, y: 104 });
    expect(g.travel).toBeCloseTo(5);
    g.up(1);
    expect(g.active).toBe(false);
  });
});

describe('helpers', () => {
  it('folds an angle into half a turn each way', () => {
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle(0.2)).toBe(0.2);
  });

  it('clamps a centre to the stage', () => {
    expect([clampCentre(-1), clampCentre(0.4), clampCentre(3)]).toEqual([0, 0.4, 1]);
  });

  it('tests a drop zone, with a margin', () => {
    const rect = { left: 10, top: 10, right: 50, bottom: 50 };
    expect(pointInRect({ x: 30, y: 30 }, rect)).toBe(true);
    expect(pointInRect({ x: 55, y: 30 }, rect)).toBe(false);
    expect(pointInRect({ x: 55, y: 30 }, rect, 8)).toBe(true);
  });
});
