/**
 * The geometry of the glass play and pause glyphs: one path serves the clip, the rim and the shadow,
 * so it must be well formed and must scale with the box (a CSS `path()` takes pixels).
 */
import { describe, it, expect } from 'vitest';
import { glassGlyphPath } from './videoGlassGlyph';

/** Every number in a path, in order. */
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('glassGlyphPath', () => {
  it('draws the play triangle as one closed shape with rounded corners', () => {
    const d = glassGlyphPath('play', 64);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.match(/M/g)).toHaveLength(1);
    // Three corners, each a curve: a sharp triangle would be three lines and no `Q`.
    expect(d.match(/Q/g)).toHaveLength(3);
  });

  it('draws the pause as two separate bars', () => {
    const d = glassGlyphPath('pause', 64);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.match(/Z/g)).toHaveLength(2);
  });

  it.each(['play', 'pause'] as const)('%s scales with the box and stays inside it', (kind) => {
    const small = numbers(glassGlyphPath(kind, 64));
    const large = numbers(glassGlyphPath(kind, 72));
    expect(large).toHaveLength(small.length);
    for (const v of large) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(72);
    }
    small.forEach((v, i) => expect(large[i]).toBeCloseTo((v * 72) / 64, 1));
  });

  it('keeps the triangle clear of the box edge, where the shadow and the rim need room', () => {
    const values = numbers(glassGlyphPath('play', 64));
    expect(Math.min(...values)).toBeGreaterThan(4);
    expect(Math.max(...values)).toBeLessThan(60);
  });
});
