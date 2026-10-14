import { describe, expect, it } from 'vitest';
import type { Association } from './api';
import {
  associationPickerOptions,
  associationSelectGroups,
  groupAssociationsForSelect,
} from './selectGroups';
import { m } from '$lib/paraglide/messages';

/** The fields the grouping reads; the rest of the row is irrelevant here. */
function row(id: string, name: string, type: Association['type'], promo?: number): Association {
  return { id, name, type, promo } as Association;
}

/**
 * The catalogue a global admin's post composer is offered, in the shape prod had on 2026-10-14:
 * clubs alphabetically BEFORE the institution, which used to sort it among them.
 */
const CATALOGUE = [
  row('c1', 'Gala Illumines', 'association'),
  row('c2', 'Les Rootz', 'association'),
  row('i1', 'Représentants de promotion ICM', 'institution'),
  row('c3', 'Zèbres', 'association'),
  row('l1', 'Liste A', 'list', 2025),
  row('l2', 'Liste B', 'list', 2026),
];

describe('groupAssociationsForSelect', () => {
  it('files an institution under its own kind, never among the associations', () => {
    const g = groupAssociationsForSelect(CATALOGUE);
    expect(g.institutions.map((a) => a.id)).toEqual(['i1']);
    expect(g.assos.map((a) => a.id)).toEqual(['c1', 'c2', 'c3']);
    expect(g.lists.map((a) => a.id)).toEqual(['l2', 'l1']);
  });
});

describe('associationPickerOptions', () => {
  it('heads the picker with the institutions, under their own heading', () => {
    const options = associationPickerOptions(CATALOGUE);
    expect(options[0]).toEqual({
      value: 'i1',
      label: 'Représentants de promotion ICM',
      group: m.asso_select_group_institutions(),
    });
    expect(
      options.filter((o) => o.group === m.asso_select_group_assos()).map((o) => o.value)
    ).toEqual(['c1', 'c2', 'c3']);
    expect(options.slice(-2)).toEqual([
      { value: 'l2', label: 'Liste B (2026)', group: m.asso_select_group_lists() },
      { value: 'l1', label: 'Liste A (2025)', group: m.asso_select_group_lists() },
    ]);
  });
});

describe('associationSelectGroups', () => {
  it('drops an empty group, so no heading is drawn over nothing', () => {
    const labels = associationSelectGroups([row('c1', 'Gala', 'association')]).map((g) => g.label);
    expect(labels).toEqual([m.asso_select_group_assos()]);
  });
});
