import { describe, expect, it } from 'vitest';
import {
  COARSE_TAP_TARGET_REM,
  SEEK_LINE_TOUCH_REM,
  clearanceAboveSeekLineRem,
} from './seekLineGeometry';

describe('clearanceAboveSeekLineRem', () => {
  it('keeps a one-line toggle and its enlarged target out of the seek line', () => {
    const lineRem = 1;
    const clearance = clearanceAboveSeekLineRem(lineRem);
    // The toggle's target bottom = clearance - overhang; it must sit at or above the line's top.
    const targetBottom = clearance - (COARSE_TAP_TARGET_REM - lineRem) / 2;
    expect(targetBottom).toBeGreaterThanOrEqual(SEEK_LINE_TOUCH_REM);
  });

  it('owes only the line itself to a control already as tall as a finger target', () => {
    expect(clearanceAboveSeekLineRem(3)).toBe(SEEK_LINE_TOUCH_REM);
  });

  it('is more than the 1rem that let "Voir plus" grab the seek line', () => {
    expect(clearanceAboveSeekLineRem(1)).toBeGreaterThan(1);
  });
});
