/**
 * The two orderings of the lists directory, asserted apart.
 *
 * ONE SHELF PER YEAR, ORDERED BY PARENT INSIDE (user, 2026-09-23). The parent association was a
 * second GROUPING level for a day, and each group opening its own grid left most of a row blank;
 * it is a sort key now, so the lists of one association are still adjacent and the cards still
 * fill the wall. The year stays the only heading - which is why the per-card "Liste 2026" pill
 * went, and why the parent needs no heading either: every card prints it.
 *
 * Every ordering here is TOTAL - no input can produce two valid renderings - and each level is
 * tested on its own, because a sort applied at one level and forgotten at the other is how this
 * comes back.
 */
import { describe, it, expect } from 'vitest';
import { buildCampaignShelves, sortByParentThenName } from './listShelves';
import type { Association } from './api';

function list(name: string, promo: number | null, parentName: string | null): Association {
  return { id: name, name, slug: name, promo, parentName, type: 'list' } as unknown as Association;
}

describe('buildCampaignShelves', () => {
  it('puts the most recent campaign first and the year-less lists last', () => {
    const shelves = buildCampaignShelves([
      list('a', 2025, null),
      list('b', null, null),
      list('c', 2027, null),
      list('d', 2026, null),
    ]);
    expect(shelves.map((s) => s.year)).toEqual([2027, 2026, 2025, 0]);
  });

  it('splits by year and only orders by parent, so one association spans several shelves', () => {
    const shelves = buildCampaignShelves([
      list('one', 2026, 'BDE'),
      list('two', 2025, 'BDE'),
      list('three', 2026, 'BDA'),
    ]);
    expect(shelves.map((s) => s.year)).toEqual([2026, 2025]);
    expect(shelves[0].items.map((i) => i.name)).toEqual(['three', 'one']);
    expect(shelves[1].items.map((i) => i.name)).toEqual(['two']);
  });

  it('keeps a year whose lists have no parent as one flat run', () => {
    // The shape the directory had before parents existed, and what most old data still looks like:
    // it must render exactly as it used to.
    const [shelf] = buildCampaignShelves([list('y', 2024, null), list('x', 2024, null)]);
    expect(shelf.items.map((i) => i.name)).toEqual(['x', 'y']);
  });
});

describe('sortByParentThenName', () => {
  it('sorts by parent name and sends the parentless lists last', () => {
    const items = sortByParentThenName([
      list('a', 2026, 'Zenith'),
      list('b', 2026, null),
      list('c', 2026, 'Elan'),
    ]);
    expect(items.map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });

  it('reads a blank parent name as no parent', () => {
    // `parentName` is denormalised on the read side, so an empty string means the parent could not
    // be resolved - not that an association is called "".
    const items = sortByParentThenName([list('a', 2026, '   '), list('b', 2026, 'BDE')]);
    expect(items.map((i) => i.name)).toEqual(['b', 'a']);
  });

  it('sorts lists of the same parent by name, with accents in their place', () => {
    const items = sortByParentThenName([
      list('Zenith', 2026, 'BDE'),
      list('Elan', 2026, 'BDE'),
      list('Ebene', 2026, 'BDE'),
    ]);
    expect(items.map((i) => i.name)).toEqual(['Ebene', 'Elan', 'Zenith']);
  });

  it('does not mutate the array it is given', () => {
    const input = [list('b', 2026, 'BDE'), list('a', 2026, 'BDE')];
    sortByParentThenName(input);
    expect(input.map((i) => i.name)).toEqual(['b', 'a']);
  });
});
