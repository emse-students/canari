import { describe, expect, it } from 'vitest';
import type { Association } from './api';
import {
  associationPickerOptions,
  associationSelectGroups,
  groupAssociationsForSelect,
} from './selectGroups';
import { m } from '$lib/paraglide/messages';

/** The fields the grouping reads; the rest of the row is irrelevant here. */
function row(
  id: string,
  name: string,
  type: Association['type'],
  promo?: number,
  archived = false
): Association {
  return { id, name, type, promo, archived } as Association;
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

/** The same catalogue with one archived row of EACH kind, named to sort before the live ones. */
const WITH_ARCHIVED = [
  ...CATALOGUE,
  row('xc', 'Ancien club', 'association', undefined, true),
  row('xi', 'Ancienne institution', 'institution', undefined, true),
  row('xl', 'Ancienne liste', 'list', 2019, true),
];

describe('archived rows', () => {
  it('leave their kind for one archived group, whatever the kind', () => {
    const g = groupAssociationsForSelect(WITH_ARCHIVED);
    expect(g.institutions.map((a) => a.id)).toEqual(['i1']);
    expect(g.assos.map((a) => a.id)).toEqual(['c1', 'c2', 'c3']);
    expect(g.lists.map((a) => a.id)).toEqual(['l2', 'l1']);
    expect(g.archived.map((a) => a.id)).toEqual(['xc', 'xi', 'xl']);
  });

  it('come in the fourth group, after institutions, associations and lists, and only it is muted', () => {
    const groups = associationSelectGroups(WITH_ARCHIVED);
    expect(groups.map((g) => [g.label, g.muted])).toEqual([
      [m.asso_select_group_institutions(), false],
      [m.asso_select_group_assos(), false],
      [m.asso_select_group_lists(), false],
      [m.asso_select_group_archived(), true],
    ]);
  });

  it('are the last options of the picker, still choosable and muted', () => {
    const options = associationPickerOptions(WITH_ARCHIVED);
    expect(options.slice(-3)).toEqual([
      { value: 'xc', label: 'Ancien club', group: m.asso_select_group_archived(), muted: true },
      {
        value: 'xi',
        label: 'Ancienne institution',
        group: m.asso_select_group_archived(),
        muted: true,
      },
      {
        value: 'xl',
        label: 'Ancienne liste (2019)',
        group: m.asso_select_group_archived(),
        muted: true,
      },
    ]);
    expect(options.some((o) => o.disabled)).toBe(false);
    expect(options.filter((o) => o.muted).length).toBe(3);
  });

  it('draw no archived heading when none is archived', () => {
    const labels = associationSelectGroups(CATALOGUE).map((g) => g.label);
    expect(labels).not.toContain(m.asso_select_group_archived());
  });
});
