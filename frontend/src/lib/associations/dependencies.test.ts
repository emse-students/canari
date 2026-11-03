import { describe, expect, it } from 'vitest';
import {
  ASSOCIATION_ADMIN_PRESET,
  AssociationPermissionFlag as F,
  SocialApiError,
  type Association,
  type DependencyEntity,
} from './api';
import {
  DEPENDENCY_REFUSAL,
  createParentField,
  creatorBdes,
  dependencyRefusalCode,
  dependencyRefusalMessage,
  dependencyRefusalText,
  dependentsOf,
  groupDependencies,
  isBde,
  labelCandidates,
  mismatchText,
  parentCandidates,
} from './dependencies';
import { bdePresetFor } from './editSections';

function entity(over: Partial<DependencyEntity> & { id: string }): DependencyEntity {
  return {
    name: over.id.toUpperCase(),
    slug: over.id,
    type: 'association',
    archived: false,
    parentAssociationId: null,
    displayParentAssociationId: null,
    governs: false,
    mismatches: [],
    ...over,
  };
}

const BDE = entity({ id: 'bde', governs: true });
const FSSS = entity({ id: 'fsss', governs: true });
const BDS = entity({ id: 'bds' });
const CLUB = entity({ id: 'club', parentAssociationId: 'bde' });
const LIST = entity({
  id: 'list',
  type: 'list',
  parentAssociationId: 'bde',
  displayParentAssociationId: 'bds',
});
const SCHOOL = entity({ id: 'school', type: 'institution', governs: true });
const ORPHAN = entity({
  id: 'orphan',
  parentAssociationId: 'bds',
  mismatches: ['parent_governs_nothing'],
});
const LONE = entity({ id: 'lone', type: 'list' });

describe('dependency refusals are classified by code, never by message', () => {
  it('reads each server code and gives each its own sentence', () => {
    const seen = new Set<string>();
    for (const code of Object.values(DEPENDENCY_REFUSAL)) {
      expect(dependencyRefusalCode(new SocialApiError('english', code, 409))).toBe(code);
      seen.add(dependencyRefusalText(code));
    }
    expect(seen.size).toBe(Object.values(DEPENDENCY_REFUSAL).length);
  });

  it('answers null for anything else, so the caller keeps its fallback', () => {
    expect(
      dependencyRefusalCode(new SocialApiError('DEPENDENCY_INSTITUTION', null, 409))
    ).toBeNull();
    expect(dependencyRefusalCode(new Error('DEPENDENCY_INSTITUTION'))).toBeNull();
    expect(dependencyRefusalMessage(new SocialApiError('x', 'OTHER', 409))).toBeNull();
  });

  it('words every mismatch differently', () => {
    const all = [
      'parent_missing',
      'parent_governs_nothing',
      'reaches_outside_parent',
      'parent_governs_none_of_audience',
    ] as const;
    expect(new Set(all.map(mismatchText)).size).toBe(all.length);
  });
});

describe('groupDependencies - every entity in exactly one place', () => {
  const tree = groupDependencies([LONE, SCHOOL, LIST, CLUB, ORPHAN, BDS, FSSS, BDE]);

  it('heads a family per parentless BDE, its children by name', () => {
    expect(tree.families.map((f) => f.bde.id)).toEqual(['bde', 'fsss']);
    expect(tree.families[0].children.map((c) => c.id)).toEqual(['club', 'list']);
    expect(tree.families[1].children).toEqual([]);
  });

  it('keeps an institution governing a space out of the BDEs (D3)', () => {
    expect(isBde(SCHOOL)).toBe(false);
    expect(tree.institutions.map((e) => e.id)).toEqual(['school']);
  });

  it('shows a child whose parent is not a BDE as orphaned rather than dropping it', () => {
    expect(tree.orphaned.map((e) => e.id)).toEqual(['orphan']);
    expect(tree.unattached.map((e) => e.id)).toEqual(['bds', 'lone']);
    const placed =
      tree.families.length +
      tree.families.reduce((n, f) => n + f.children.length, 0) +
      tree.institutions.length +
      tree.unattached.length +
      tree.orphaned.length;
    expect(placed).toBe(8);
  });

  it('offers the BDEs as parents and the non-governing associations as labels (G3)', () => {
    const all = [LONE, SCHOOL, LIST, CLUB, BDS, FSSS, BDE];
    expect(parentCandidates(all).map((e) => e.id)).toEqual(['bde', 'fsss']);
    expect(labelCandidates(all).map((e) => e.id)).toEqual(['bds', 'club']);
  });
});

describe('the parent field of the create form (reform 2.5, B1)', () => {
  const bde = { id: 'bde', name: 'BDE' };
  const fsss = { id: 'fsss', name: 'BDE FSSS' };
  const bds = { id: 'bds', name: 'BDS' };

  it('asks nothing of a creator managing one BDE, and says which', () => {
    const field = createParentField('association', false, [bde], [bds]);
    expect(field).toMatchObject({ options: [], fixed: bde, required: false });
  });

  it('lets a list of that creator be shown under a non-BDE, defaulting to the BDE', () => {
    const field = createParentField('list', false, [bde], [bds]);
    expect(field.fixed).toEqual(bde);
    expect(field.options.map((o) => o.value)).toEqual(['', 'bds']);
  });

  it('requires a pick among several BDEs, and offers no label then', () => {
    const field = createParentField('list', false, [bde, fsss], [bds]);
    expect(field.required).toBe(true);
    expect(field.options.map((o) => o.value)).toEqual(['', 'bde', 'fsss']);
  });

  it('lets a platform admin pick a BDE, a label or nothing', () => {
    const field = createParentField('list', true, [bde, fsss], [bds]);
    expect(field).toMatchObject({ fixed: null, required: false, initial: '' });
    expect(field.options.map((o) => o.value)).toEqual(['', 'bde', 'fsss', 'bds']);
  });

  it("keeps only the creator's own parentless BDEs where it holds MANAGE_ASSO", () => {
    const row = (over: Partial<Association>) =>
      ({
        id: 'x',
        name: 'X',
        type: 'association',
        isBDE: true,
        permissions: F.MANAGE_ASSO,
        parentAssociationId: null,
        ...over,
      }) as Association;
    const mine = [
      row({ id: 'b', name: 'B' }),
      row({ id: 'a', name: 'A' }),
      row({ id: 'no-right', permissions: F.EDIT_PROFILE }),
      row({ id: 'not-bde', isBDE: false }),
      row({ id: 'school', type: 'institution' }),
      row({ id: 'child', parentAssociationId: 'a' }),
    ];
    expect(creatorBdes(mine).map((a) => a.id)).toEqual(['a', 'b']);
  });
});

describe('what a BDE edit page shows (F9)', () => {
  it('lists the dependents of one BDE, live ones first', () => {
    const dir = [
      { id: '1', name: 'Zeta', archived: false, parentAssociationId: 'bde' },
      { id: '2', name: 'Alpha', archived: true, parentAssociationId: 'bde' },
      { id: '3', name: 'Beta', archived: false, parentAssociationId: 'bde' },
      { id: '4', name: 'Other', archived: false, parentAssociationId: 'fsss' },
    ];
    expect(dependentsOf(dir, 'bde').map((a) => a.id)).toEqual(['3', '1', '2']);
  });

  it('offers the BDE preset (admin + the three BDE rights) on a BDE only', () => {
    const preset = bdePresetFor({ type: 'association', isBDE: true });
    expect(preset).toBe(ASSOCIATION_ADMIN_PRESET | F.VALIDATE_EVENTS | F.MANAGE_ASSO | F.MODERATE);
    expect(bdePresetFor({ type: 'association', isBDE: false })).toBeNull();
    expect(bdePresetFor({ type: 'institution', isBDE: true })).toBeNull();
  });
});
