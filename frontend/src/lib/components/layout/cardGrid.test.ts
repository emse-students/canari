import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_GRID, CARD_GRID_MIN } from './cardGrid';

// FROM `process.cwd()`, NOT FROM `import.meta.url`, for the reason its sibling
// `sessionExpiredRelease.test.ts` already records: under this directory Vite hands the module a
// non-`file:` `import.meta.url`, and reading `.pathname` off it yields `/F:/src/routes` - a real
// path, just not this one, so the walk fails with ENOENT rather than a wrong answer.
const ROUTES = join(process.cwd(), 'src/routes');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return name.endsWith('.svelte') ? [full] : [];
  });
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
  // one of these grids can hold one item.
  it('sizes by the card and not by a column count', () => {
    expect(CARD_GRID).toContain('auto-fill');
    expect(CARD_GRID).not.toMatch(/grid-cols-\d/);
  });

  // THE POINT OF THE CONSTANT IS THAT THERE IS ONE. Six identical literals is what it replaced,
  // and nothing stops a seventh being typed by hand except this.
  //
  // THE SIGNATURE IS THE LADDER, NOT THE GRID. A first draft of this guard matched any
  // `grid gap-4 sm:grid-cols-*` and caught `/calendar`'s start/end datetime pair - two fields
  // side by side, which is a FORM ROW and correctly a fixed count, because two inputs do not
  // re-flow into three. What the six copies had in common was climbing 2 -> 3 -> 4 as the window
  // grew, and that is the decision `auto-fill` replaces.
  it('is the only card wall in the routes', () => {
    const offenders = svelteFiles(ROUTES).filter((file) =>
      /sm:grid-cols-2 lg:grid-cols-3/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
