import { describe, expect, it } from 'vitest';
import { createEmojiOverlay, type ReelOverlay } from './reelOverlays';
import {
  MAX_UNDO_STEPS,
  createStrokeOverlay,
  erasedAt,
  layoutChanged,
  pushedHistory,
  strokeBox,
  strokeTouched,
} from './reelStrokes';

const line = (color = '#fff') =>
  createStrokeOverlay(
    [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ],
    400,
    800,
    color,
    0.01
  )!;

describe('reel strokes', () => {
  it('centres a stroke on its bounding box, in short-side units, and refuses a dot', () => {
    const stroke = line();
    expect(stroke).toMatchObject({ kind: 'stroke', x: 0.5, y: 0.25, scale: 1, rotation: 0 });
    expect(stroke.points).toEqual([
      { x: -0.25, y: 0 },
      { x: 0.25, y: 0 },
    ]);
    expect(createStrokeOverlay([{ x: 1, y: 1 }], 400, 800, '#fff', 0.01)).toBeNull();
    expect(createStrokeOverlay([], 0, 0, '#fff', 0.01)).toBeNull();
  });

  it('pads the box by half a line so the round caps never clip', () => {
    expect(strokeBox(line())).toEqual({ x: -0.255, y: -0.005, width: 0.51, height: 0.01 });
  });

  it('is touched by an eraser near the line, not far from it, and follows the transform', () => {
    const stroke = line();
    expect(strokeTouched(stroke, { x: 200, y: 205 }, 400, 800)).toBe(true);
    expect(strokeTouched(stroke, { x: 200, y: 260 }, 400, 800)).toBe(false);
    // Moved down and turned a quarter: the line is now vertical at x = 200, y from 400 to 600 about (200, 500).
    const turned = { ...stroke, x: 0.5, y: 0.625, rotation: Math.PI / 2 };
    expect(strokeTouched(turned, { x: 202, y: 500 }, 400, 800)).toBe(true);
    expect(strokeTouched(turned, { x: 300, y: 500 }, 400, 800)).toBe(false);
    // A pinched-up stroke is longer: a point past the old end now touches.
    const bigger = { ...stroke, scale: 2 };
    expect(strokeTouched(stroke, { x: 350, y: 200 }, 400, 800)).toBe(false);
    expect(strokeTouched(bigger, { x: 350, y: 200 }, 400, 800)).toBe(true);
  });

  it('erases only strokes, and returns the same array when nothing is touched', () => {
    const stroke = line();
    const emoji = { ...createEmojiOverlay('\u{1F525}'), x: 0.5, y: 0.25 };
    const all: ReelOverlay[] = [emoji, stroke];
    expect(erasedAt(all, { x: 200, y: 200 }, 400, 800)).toEqual([emoji]);
    expect(erasedAt(all, { x: 10, y: 700 }, 400, 800)).toBe(all);
  });

  it('tells a moved layout from a mere reselection, and caps the undo history', () => {
    const stroke = line();
    expect(layoutChanged([stroke], [{ ...stroke }])).toBe(false);
    expect(layoutChanged([stroke], [{ ...stroke, x: 0.6 }])).toBe(true);
    expect(layoutChanged([stroke], [])).toBe(true);
    let history: ReelOverlay[][] = [];
    for (let i = 0; i < MAX_UNDO_STEPS + 5; i += 1) history = pushedHistory(history, []);
    expect(history).toHaveLength(MAX_UNDO_STEPS);
  });
});
