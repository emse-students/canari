import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A POST CARD IS SEPARATED FROM THE PAGE BY LIGHTNESS IN DARK, NOT BY A HAIRLINE.
 *
 * Design audit vs Facebook, 2026-11-09: the card's `dark:border-white/15` sat on top of the 18-point
 * step between `--cn-surface` (#121212) and the true-black ground, which already separates them -
 * and Facebook's dark feed carries no outline at all. The border stays, transparent, so the box
 * keeps its size. Source-pinned because nothing else notices a hairline coming back.
 */
describe('PostCard dark edge', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'PostCard.svelte'),
    'utf8'
  );

  it('draws no visible outline in dark', () => {
    const card = source.split(/\r?\n/).find((line) => line.includes('class="group/card'));
    expect(card).toBeDefined();
    expect(card).toContain('dark:border-transparent');
    expect(card).not.toMatch(/dark:border-white\/\d+/);
  });
});
