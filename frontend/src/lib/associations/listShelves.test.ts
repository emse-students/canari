/**
 * The two orderings of the lists directory, asserted apart.
 *
 * YEAR OUTSIDE, PARENT INSIDE (user, 2026-09-22). The year was already the shelf heading, which is
 * why the per-card "Liste 2026" pill went: it repeated the heading the card sits under. The parent
 * association is the division WITHIN a year, because a campaign happens in a year and an
 * association runs several of them.
 *
 * Every ordering here is TOTAL - no input can produce two valid renderings - and each level is
 * tested on its own, because a sort applied at one level and forgotten at the other is how this
 * comes back.
 */
import { describe, it, expect } from 'vitest';
import { buildCampaignShelves, groupByParent } from './listShelves';
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

  it('divides each year by parent association, not the other way round', () => {
    const shelves = buildCampaignShelves([
      list('one', 2026, 'BDE'),
      list('two', 2025, 'BDE'),
      list('three', 2026, 'BDA'),
    ]);
    // Two years, and BDE appears inside BOTH of them rather than owning a shelf of its own.
    expect(shelves.map((s) => s.year)).toEqual([2026, 2025]);
    expect(shelves[0].groups.map((g) => g.parentName)).toEqual(['BDA', 'BDE']);
    expect(shelves[1].groups.map((g) => g.parentName)).toEqual(['BDE']);
  });

  it('keeps a year whose lists have no parent as a single unlabelled group', () => {
    // The shape the directory had before parents existed, and what most old data still looks like:
    // it must render exactly as it used to rather than growing an empty heading.
    const [shelf] = buildCampaignShelves([list('x', 2024, null), list('y', 2024, null)]);
    expect(shelf.groups).toHaveLength(1);
    expect(shelf.groups[0].parentName).toBeNull();
    expect(shelf.groups[0].items.map((i) => i.name)).toEqual(['x', 'y']);
  });
});

describe('groupByParent', () => {
  it('sorts parents by name and sends the parentless group last', () => {
    const groups = groupByParent([
      list('a', 2026, 'Zenith'),
      list('b', 2026, null),
      list('c', 2026, 'Elan'),
    ]);
    expect(groups.map((g) => g.parentName)).toEqual(['Elan', 'Zenith', null]);
  });

  it('reads a blank parent name as no parent', () => {
    // `parentName` is denormalised on the read side, so an empty string means the parent could not
    // be resolved - not that an association is called "".
    const groups = groupByParent([list('a', 2026, '   '), list('b', 2026, 'BDE')]);
    expect(groups.map((g) => g.parentName)).toEqual(['BDE', null]);
  });

  it('sorts lists inside a group by name, with accents in their place', () => {
    const [group] = groupByParent([
      list('Zenith', 2026, 'BDE'),
      list('Elan', 2026, 'BDE'),
      list('Ebene', 2026, 'BDE'),
    ]);
    expect(group.items.map((i) => i.name)).toEqual(['Ebene', 'Elan', 'Zenith']);
  });

  it('does not mutate the array it is given', () => {
    const input = [list('b', 2026, 'BDE'), list('a', 2026, 'BDE')];
    groupByParent(input);
    expect(input.map((i) => i.name)).toEqual(['b', 'a']);
  });
});
