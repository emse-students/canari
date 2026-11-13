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

/**
 * THE CARD STANDS OFF BY TONE: `--cn-surface-card` is a step lighter than the page in dark, the
 * same as `--cn-surface` in light, and the post card (and nothing else) fills with it.
 */
describe('PostCard dark fill token', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(dir, '../../../app.css'), 'utf8');
  const card = readFileSync(join(dir, 'PostCard.svelte'), 'utf8');

  it('defines a lighter dark card fill than the panel surface', () => {
    // The dark theme block comes last in the file, so its value is the last match.
    const hex = (name: string) => {
      const all = [...css.matchAll(new RegExp(`--cn-surface${name}: #([0-9a-f]{6});`, 'g'))];
      return parseInt(all[all.length - 1][1].slice(0, 2), 16);
    };
    expect(hex('-card')).toBeGreaterThan(hex(''));
    expect(css).toContain('--color-cn-card: var(--cn-surface-card);');
  });

  it('fills the post card with it', () => {
    const line = card.split(/\r?\n/).find((l) => l.includes('class="group/card'));
    expect(line).toContain('bg-cn-card');
  });
});
