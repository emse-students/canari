import { describe, expect, it } from 'vitest';
import { columnsFor, layoutMasonry, nearEnd, visibleTiles } from './gifMasonry';

describe('layoutMasonry', () => {
  it('sizes every tile from its declared ratio, before anything loads', () => {
    const { tiles } = layoutMasonry(
      [
        { width: 200, height: 100 },
        { width: 100, height: 200 },
      ],
      208,
      2,
      8
    );
    // Columns of 100 px: a 2:1 GIF is 50 tall, a 1:2 one 200.
    expect(tiles.map((t) => [t.x, t.y, t.width, t.height])).toEqual([
      [0, 0, 100, 50],
      [108, 0, 100, 200],
    ]);
  });

  it('puts the next tile under the SHORTEST column, the leftmost on a tie', () => {
    const { tiles, height } = layoutMasonry(
      [
        { width: 1, height: 1 },
        { width: 1, height: 2 },
        { width: 1, height: 1 },
      ],
      208,
      2,
      8
    );
    expect(tiles[2]).toMatchObject({ x: 0, y: 108 });
    expect(height).toBe(208);
  });

  it('is empty for no GIFs', () => {
    expect(layoutMasonry([], 300, 2, 8)).toEqual({ tiles: [], height: 0 });
  });
});

describe('visibleTiles', () => {
  it('mounts only the tiles near the scrolled window', () => {
    const sizes = Array.from({ length: 40 }, () => ({ width: 1, height: 1 }));
    const { tiles } = layoutMasonry(sizes, 208, 2, 8); // 20 rows of 108 px
    const shown = visibleTiles(tiles, 1080, 300, 100);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(14);
    for (const t of shown) {
      expect(t.y + t.height).toBeGreaterThanOrEqual(980);
      expect(t.y).toBeLessThanOrEqual(1480);
    }
  });
});

describe('columnsFor and nearEnd', () => {
  it('uses two columns on a phone and three from 480 px', () => {
    expect(columnsFor(390)).toBe(2);
    expect(columnsFor(480)).toBe(3);
  });

  it('asks for the next page only near the end of a non-empty grid', () => {
    expect(nearEnd(0, 300, 0, 200)).toBe(false);
    expect(nearEnd(500, 300, 1000, 200)).toBe(true);
    expect(nearEnd(100, 300, 1000, 200)).toBe(false);
  });
});
