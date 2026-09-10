/**
 * The page column exists to stop every route inventing its own width, and it was doing that job
 * with TWO values until a third shape was measured. Nothing else can hold the set closed: a fourth
 * entry here, or a `max-w-*` written at a call site, both compile and both look reasonable in the
 * diff that adds them.
 *
 * So this asserts three things, and the third is the one that catches the real regression: that
 * the shapes are strictly ORDERED. A `grid` narrower than `tool`, or a `reading` that crept wider
 * than either, is a scale that has stopped meaning anything - and it is exactly what happens when
 * someone widens the value their own page needed rather than asking which shape it is.
 */
import { describe, it, expect } from 'vitest';
import { PAGE_WIDTHS, type PageWidth } from './pageWidth';

/** `max-w-5xl` and `max-w-[42.5rem]` both have to become one comparable number. */
function pixelsOf(utility: string): number {
  const arbitrary = /^max-w-\[([\d.]+)rem]$/.exec(utility);
  if (arbitrary) return Number(arbitrary[1]) * 16;
  // The Tailwind scale, only the steps this file is allowed to use.
  const named: Record<string, number> = { 'max-w-5xl': 64 * 16 };
  const px = named[utility];
  if (px === undefined) {
    throw new Error(
      `${utility} is neither a rem value nor a scale step this test knows. Add it here WITH its ` +
        'pixel size, so the ordering assertion keeps meaning something.'
    );
  }
  return px;
}

describe('the page widths', () => {
  it('declares exactly three shapes, and a page is one of them or the question is about the page', () => {
    expect(Object.keys(PAGE_WIDTHS).sort()).toEqual(['grid', 'reading', 'tool']);
  });

  it('orders them reading < tool < grid, so the scale keeps meaning something', () => {
    const [reading, tool, grid] = (['reading', 'tool', 'grid'] as PageWidth[]).map((shape) =>
      pixelsOf(PAGE_WIDTHS[shape])
    );

    expect(reading).toBeLessThan(tool);
    expect(tool).toBeLessThan(grid);
  });

  it('keeps the reading measure at the feed value, which is the one the user named', () => {
    // 680px. It is the reference for every prose route, so a change here is a change to the whole
    // app's line length and must be deliberate rather than a side effect of widening a grid.
    expect(pixelsOf(PAGE_WIDTHS.reading)).toBe(680);
  });

  it('caps the grid rather than going full-bleed', () => {
    // An uncapped container on a 3440px display draws nine columns of small cards. The cap is the
    // one judgement in `pageWidth.ts` and it is asserted so that removing it is a visible choice.
    expect(pixelsOf(PAGE_WIDTHS.grid)).toBe(1600);
  });
});
