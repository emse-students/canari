import { describe, expect, it } from 'vitest';
import { rovingTarget } from './rovingFocus';

describe('rovingTarget', () => {
  it('moves forward and back, wrapping at both ends', () => {
    expect(rovingTarget('ArrowRight', 0, 5)).toBe(1);
    expect(rovingTarget('ArrowDown', 4, 5)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 5)).toBe(4);
    expect(rovingTarget('ArrowUp', 3, 5)).toBe(2);
  });

  it('jumps with Home and End, and ignores every other key', () => {
    expect(rovingTarget('Home', 3, 5)).toBe(0);
    expect(rovingTarget('End', 1, 5)).toBe(4);
    expect(rovingTarget('Enter', 1, 5)).toBe(-1);
    expect(rovingTarget('ArrowRight', 0, 0)).toBe(-1);
  });
});
