import { describe, it, expect } from 'vitest';
import { confettiCount, confettiLayout, ringWidthPx } from './confettiLayout';

describe('confettiLayout', () => {
  it('scales the count with the size: 12, 8, 5', () => {
    expect([112, 56, 48].map(confettiCount)).toEqual([12, 12, 12]);
    expect([32, 30].map(confettiCount)).toEqual([8, 8]);
    expect([24, 16, 29].map(confettiCount)).toEqual([5, 5, 5]);
  });

  it('is deterministic', () => {
    expect(confettiLayout(56)).toEqual(confettiLayout(56));
  });

  it('uses only dots below 30 px', () => {
    expect(confettiLayout(24).every((p) => p.dot)).toBe(true);
  });

  it('floats every piece 14% to 24% of the size beyond the photo edge, never further', () => {
    for (const size of [16, 24, 32, 56, 112]) {
      for (const p of confettiLayout(size)) {
        const d = Math.hypot(p.xPct - 50, p.yPct - 50);
        expect(d).toBeGreaterThanOrEqual(50 + 14 - 0.001);
        expect(d).toBeLessThanOrEqual(50 + 24 + 0.001);
        expect(p.colour).toBeGreaterThanOrEqual(0);
        expect(p.colour).toBeLessThan(4);
      }
    }
  });

  it('has a ring of max(2px, 6%)', () => {
    expect(ringWidthPx(16)).toBe(2);
    expect(ringWidthPx(112)).toBeCloseTo(6.72);
  });
});
