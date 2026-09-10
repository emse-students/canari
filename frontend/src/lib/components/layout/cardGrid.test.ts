import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_GRID, CARD_GRID_MIN } from './cardGrid';

// FROM `process.cwd()`, NOT FROM `import.meta.url`, for the reason its sibling
// `sessionExpiredRelease.test.ts` already records: under this directory Vite hands the module a
// non-`file:` `import.meta.url`, and reading `.pathname` off it yields `/F:/src/routes` - a real
// path, just not this one, so the walk fails with ENOENT rather than a wrong answer.
const SRC = join(process.cwd(), 'src');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return name.endsWith('.svelte') ? [full] : [];
  });
}

/**
 * A line that opens an element carrying a grid class, whatever else it carries.
 *
 * CASE-INSENSITIVE ON PURPOSE, and the first run of this file proves why: a BROKEN wall spells the
 * class out in lowercase, `grid gap-4 ...`, while a REPAIRED one interpolates the constant,
 * `class={CARD_GRID}`, where the word is upper-case. Matching only lowercase found NOTHING once the
 * four walls were repaired, and the offender check passed vacuously - the very shape of failure
 * this pair guards against.
 */
const GRID_LINE = /class=(["{])[^">]*grid/i;

/**
 * How far above a `<CardTile` its wrapping grid may sit. The four walls found on 2026-09-10 put it
 * 1-3 lines up and `/shop` puts it 4 up, through an intervening `{#each}` and sometimes an `<li>`.
 * Ten is generous enough to survive a wrapper being added and short enough that it cannot reach
 * past the block into an unrelated grid earlier in the file.
 */
const LOOKBACK = 10;

/**
 * Every `<CardTile` in the tree, paired with the nearest grid that encloses it - or `null` when
 * the tile does not sit in a grid at all, which is how a single preview tile reads.
 */
function cardTileGrids(): { file: string; line: number; grid: string | null }[] {
  const found: { file: string; line: number; grid: string | null }[] = [];
  for (const file of svelteFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/<CardTile\b/.test(lines[i])) continue;
      let grid: string | null = null;
      for (let j = i - 1; j >= 0 && j >= i - LOOKBACK; j--) {
        if (GRID_LINE.test(lines[j])) {
          grid = lines[j].trim();
          break;
        }
      }
      found.push({
        file: file
          .slice(SRC.length + 1)
          .split('\\')
          .join('/'),
        line: i + 1,
        grid,
      });
    }
  }
  return found;
}

describe('CARD_GRID', () => {
  // The interpolation this asserts against is the one that WOULD have been written: Tailwind
  // scans text, so a class assembled at runtime resolves to no rule at all. Keeping the constant
  // and the literal in step is therefore a test's job rather than the compiler's.
  it('spells out the minimum the constant states', () => {
    expect(CARD_GRID).toContain(`minmax(${CARD_GRID_MIN},1fr)`);
  });

  // `auto-fill` and not `auto-fit`: `auto-fit` collapses the empty tracks and stretches the
  // survivors, so a section holding ONE association would draw a single card 1600px wide. Every
  // one of these grids can hold one item, and the partnerships wall routinely holds two.
  it('sizes by the card and not by a column count', () => {
    expect(CARD_GRID).toContain('auto-fill');
    expect(CARD_GRID).not.toMatch(/grid-cols-\d/);
  });

  /**
   * A GRID HOLDING `CardTile` MUST BE THIS ONE, AND THE PREVIOUS GUARD ASKED THE WRONG QUESTION.
   *
   * It matched the literal ladder `sm:grid-cols-2 lg:grid-cols-3`, because that is what the six
   * copies it was written against happened to share, and it walked `src/routes` only. A seventh
   * wall escaped BOTH halves at once: `PartnershipCardList` lives in `src/lib/components/`, where
   * the walk never reached, and it stops climbing at two columns, so the ladder never matched.
   * The user saw the result at a 1384px window - two partnership tiles 660px wide, against a
   * measured Amazon tile of 205px. Three more walls were in the same state once looked for.
   *
   * A guard narrowed to the shape of the copies it already knows is not a guard, so this one
   * names the thing instead of the styling. `CardTile` IS the card: a grid that renders one is a
   * card wall by construction, and no amount of re-typing the classes can disguise that. The
   * first draft of this rewrite matched any grid sitting above an `{#each}` and accused 21 places
   * - a PIN keypad at 3 columns, a month at 7, a colour palette at 5, a photo mosaic at 2 - every
   * one of them a fixed count that IS the design and must never re-flow. None of them renders a
   * `CardTile`, and that is the whole difference.
   */
  it('is the grid around every CardTile in the tree', () => {
    const inAGrid = cardTileGrids().filter((t) => t.grid !== null);
    const offenders = inAGrid.filter((t) => !t.grid!.includes('CARD_GRID'));
    expect(offenders).toEqual([]);
  });

  /**
   * The guard above is vacuous if the lookback stops finding the grids, and that is not a
   * hypothetical: the first run of this rewrite found ZERO and passed the offender check clean,
   * because the pattern was case-sensitive and every repaired wall now spells `{CARD_GRID}`.
   *
   * FIVE IS MEASURED, NOT ESTIMATED - a first draft of this line guessed seven from the "six
   * copies" story and was simply wrong. The tree holds six files rendering `CardTile`; five put
   * it in a wall, and `CardIconEditor` draws ONE tile as a preview of an icon being chosen, which
   * is correctly not a grid at all. Raise this number when a wall is added, never lower it to
   * make a run go green.
   */
  it('actually finds the card walls it claims to check', () => {
    const inAGrid = cardTileGrids().filter((t) => t.grid !== null);
    expect(inAGrid.length).toBeGreaterThanOrEqual(5);
  });
});
