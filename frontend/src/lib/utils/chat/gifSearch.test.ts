import { describe, expect, it } from 'vitest';
import { mapKlipyItems } from './gifSearch';

const sized = (url: string, width: number, height: number) => ({ gif: { url, width, height } });

describe('mapKlipyItems', () => {
  it('keeps the small rendition for the grid and the medium one to send, each with its size', () => {
    const { gifs, dropped } = mapKlipyItems([
      { id: 7, file: { sm: sized('s.gif', 220, 124), md: sized('m.gif', 498, 280) } },
    ]);
    expect(dropped).toBe(0);
    expect(gifs).toEqual([
      {
        id: '7',
        preview: { url: 's.gif', width: 220, height: 124 },
        full: { url: 'm.gif', width: 498, height: 280 },
      },
    ]);
  });

  it('leaves out and COUNTS a result with no declared size - it could not be laid out', () => {
    const { gifs, dropped } = mapKlipyItems([
      { id: 1, file: { sm: { gif: { url: 'a.gif' } }, md: { gif: { url: 'b.gif' } } } },
      { id: 2, file: { sm: sized('c.gif', 0, 10), md: sized('d.gif', 10, 10) } },
      { file: { sm: sized('e.gif', 1, 1) } },
    ]);
    // #2 still has a sized medium rendition, used for the grid too.
    expect(gifs.map((g) => g.id)).toEqual(['2']);
    expect(gifs[0].preview.url).toBe('d.gif');
    expect(dropped).toBe(2);
  });
});
