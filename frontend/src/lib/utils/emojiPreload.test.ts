/**
 * THE EMOJI PICKER PAINTS AT ONCE (iPhone, 2026-11-08: blank cells, cells that grew in, empty
 * recents, a stray glyph in the tab bar). The cause was a cold, lazy, asynchronously decoded set of
 * pictures with no box of their own; these pin the decision. Whether a phone paints in one frame is
 * a reading (device-verification), so the grid half is a SOURCE pin, said honestly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRST_SCREEN_EMOJI_COUNT,
  firstScreenEmoji,
  tabIconEmoji,
  warmEmojiPictures,
} from './emojiPreload';
import { EMOJI_CATEGORIES, buildCatalog, type DatasetEntry } from './emojiCatalog';

const dataset = JSON.parse(
  readFileSync(join(process.cwd(), 'static', 'emoji-data-en.json'), 'utf8')
) as DatasetEntry[];
const entries = buildCatalog(dataset);
const grid = readFileSync(
  join(process.cwd(), 'src', 'lib', 'components', 'messages', 'EmojiGrid.svelte'),
  'utf8'
);

describe('what the picker warms', () => {
  it('is the first screen of the first category, in the grid order', () => {
    const first = firstScreenEmoji(entries, 0);
    expect(first).toHaveLength(FIRST_SCREEN_EMOJI_COUNT);
    const smileys = entries.filter((e) => e.category === EMOJI_CATEGORIES[0]);
    expect(first[0]).toBe(smileys[0].emoji);
  });

  it('is one tab icon per category, the one the tab bar draws', () => {
    expect(tabIconEmoji(entries)).toHaveLength(EMOJI_CATEGORIES.length);
  });

  it('does nothing outside a browser and never throws', () => {
    expect(() => warmEmojiPictures(['/emoji/x/1f600.svg', null])).not.toThrow();
  });
});

describe('the grid cells', () => {
  it('carry an explicit width and height, so no cell lays out at 0 and grows', () => {
    expect(grid).toMatch(/<img[^>]*class="size-7[^"]*"[^>]*width="28"[^>]*height="28"/s);
    expect(grid).toMatch(/<img[^>]*class="size-5[^"]*"[^>]*width="20"[^>]*height="20"/s);
  });

  it('are eager and synchronously decoded on the first screen, lazy only below it', () => {
    expect(grid).toContain("loading={eager ? 'eager' : 'lazy'}");
    expect(grid).toContain("decoding={eager ? 'sync' : 'async'}");
    expect(grid).toContain('index < FIRST_SCREEN_EMOJI_COUNT');
  });

  it('draw the tab icons as pictures of their own, not lazy', () => {
    const tab = /<img[^>]*class="size-5[^>]*>/s.exec(grid)![0];
    expect(tab).not.toContain('loading="lazy"');
    expect(tab).toContain('decoding="sync"');
  });

  it('never show the alt glyph while a picture is on its way', () => {
    for (const m of grid.matchAll(/<img[^>]*class="size-[57][^"]*"/gs)) {
      expect(m[0]).toContain('text-transparent');
    }
  });
});

describe('the emoji setting (2026-11-09)', () => {
  const preload = readFileSync(
    join(process.cwd(), 'src', 'lib', 'utils', 'emojiPreload.ts'),
    'utf8'
  );

  it('decides what the warm-up and the grid fetch: no picture at all under "system"', () => {
    expect(preload).toContain('emojiPictureSrc(emoji)');
    expect(preload).not.toContain('emojiSvgSrc');
    expect(grid).toContain('emojiPictureSrc(');
    expect(grid).not.toContain('emojiSvgSrc');
  });
});
