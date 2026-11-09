import { describe, expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../../../test/sourceTree';
import { CARD_GRID, CARD_GRID_MIN } from './cardGrid';

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
 * How far above a component's OWN tag its wrapping grid may sit, for the one-level indirection
 * below. Wider than `LOOKBACK`: the tag sits one `{#if}`/`{#each}` further from the wall than a
 * `<CardTile` does, by construction - `ProductCard`/`MembershipCard` (#2546) measure 11, so 15
 * leaves the same margin `LOOKBACK` leaves the direct case, no more.
 */
const CALLER_LOOKBACK = 15;

/** The nearest line matching `GRID_LINE` within `span` lines above `lines[i]`, or null. */
function nearestGridAbove(lines: string[], i: number, span: number): string | null {
  for (let j = i - 1; j >= 0 && j >= i - span; j--) {
    if (GRID_LINE.test(lines[j])) return lines[j].trim();
  }
  return null;
}

/** A file's own component name, as a template would tag it: `ProductCard` for `ProductCard.svelte`. */
function componentNameOf(file: string): string {
  return file
    .split(/[\\/]/)
    .pop()!
    .replace(/\.svelte$/, '');
}

/**
 * Every `<CardTile` among `files`, paired with the nearest grid that encloses it - `null` when the
 * tile does not sit in a grid at all, which is how a single preview tile reads - following ONE
 * level of component extraction when the wall and the tile live in different files.
 *
 * `ProductCard.svelte` and `MembershipCard.svelte` (#2546) render `<CardTile` with no grid class
 * anywhere in their OWN source: the wall stays in the page that lays out `/shop`, one level up,
 * wrapping `<ProductCard>`/`<MembershipCard>` instead. A scan confined to one file would read this
 * exactly like the escaped `PartnershipCardList` wall of 2026-09-10 - a false negative, not a real
 * one - so a `<CardTile` with no local grid is re-checked against every place its OWN component is
 * RENDERED, and counts as walled if any of those call sites sits under a grid class. FURTHER
 * indirection (a grid two components away) is NOT followed: a guard that permissive stops meaning
 * anything, per the comment on the offender check below.
 *
 * Takes `files` rather than reading the tree itself, so the mutation test below can hand it a
 * two-file fixture and prove the indirection actually bites, rather than trusting that the real
 * tree happens to exercise it.
 */
function resolveCardTileGrids(
  files: readonly { path: string; text: string }[]
): { file: string; line: number; grid: string | null }[] {
  const found: { file: string; line: number; grid: string | null }[] = [];

  for (const { path: file, text } of files) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/<CardTile\b/.test(lines[i])) continue;
      let grid = nearestGridAbove(lines, i, LOOKBACK);
      if (grid === null) {
        const tag = new RegExp(`<${componentNameOf(file)}\\b`);
        for (const caller of files) {
          if (caller.path === file) continue;
          const callerLines = caller.text.split('\n');
          for (let k = 0; k < callerLines.length; k++) {
            if (!tag.test(callerLines[k])) continue;
            const callerGrid = nearestGridAbove(callerLines, k, CALLER_LOOKBACK);
            if (callerGrid !== null) grid = callerGrid;
          }
          if (grid !== null) break;
        }
      }
      found.push({
        file: relativeTo(file, 'src'),
        line: i + 1,
        grid,
      });
    }
  }
  return found;
}

/** `resolveCardTileGrids` over the real tree, for the two tests below. */
function cardTileGrids(): { file: string; line: number; grid: string | null }[] {
  return resolveCardTileGrids([
    ...sourceFiles({ under: 'src', extensions: ['svelte'], tests: 'include' }),
  ]);
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

  /**
   * MUTATION TEST for the one-level indirection above: a synthetic two-file fixture, not the real
   * tree, so a passing suite proves the MECHANISM catches an escaped wall rather than proving the
   * real files currently happen to have one. `page.svelte`'s grid wraps `<Child>`, which renders
   * `<CardTile` with no grid of its own - resolved while the wall is there, and the second case
   * removes exactly that class to confirm the guard would have failed it.
   */
  describe('the one-level indirection, proven by mutation', () => {
    const child = {
      path: 'src/lib/Child.svelte',
      text: ['<script></script>', '', '<CardTile>', '  content', '</CardTile>'].join('\n'),
    };
    const pageWithWall = {
      path: 'src/routes/page.svelte',
      text: [
        '<div class={CARD_GRID}>',
        '  {#each items as item}',
        '    <Child {item} />',
        '  {/each}',
        '</div>',
      ].join('\n'),
    };

    it('resolves the child CardTile to the parent wall when the wall is there', () => {
      const [found] = resolveCardTileGrids([child, pageWithWall]);
      expect(found.grid).toContain('CARD_GRID');
    });

    it('MUTATION: removing the wall class from the parent makes the same CardTile un-walled', () => {
      const pageWithoutWall = { ...pageWithWall, text: pageWithWall.text.replace('CARD_GRID', '') };
      const [found] = resolveCardTileGrids([child, pageWithoutWall]);
      expect(found.grid).toBeNull();
    });
  });
});
