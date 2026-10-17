import { describe, expect, it } from 'vitest';
import type { Association } from '$lib/associations/api';
import { dashboardHubGroups, type DashboardFacts } from './dashboardSections';

const org = (over: Partial<Association>): Association =>
  ({
    id: over.slug ?? 'x',
    name: over.slug ?? 'x',
    slug: 'x',
    logoUrl: null,
    type: 'association',
    isAdmin: true,
    archived: false,
    role: 'Membre',
    ...over,
  }) as Association;

function groups(memberships: Association[]) {
  const facts = {
    userId: 'u',
    displayName: null,
    unreadNotifications: 0,
    mayOpenAdmin: false,
    adminScope: { title: () => 'Admin' },
    isReviewer: false,
    memberships,
    probesSettled: true,
  } as unknown as DashboardFacts;
  return dashboardHubGroups(facts, { signOut: () => {} });
}

const rowsOf = (memberships: Association[], key: string) =>
  groups(memberships).find((g) => g.key === key)?.rows;

describe('dashboard managed groups', () => {
  it('gives each kind its own group, in the order associations, lists, institutions', () => {
    const keys = groups([
      org({ slug: 'ecole', type: 'institution' }),
      org({ slug: 'bde' }),
      org({ slug: 'liste', type: 'list', promo: 2026 }),
    ]).map((g) => g.key);
    expect(keys.filter((k) => k.startsWith('managed'))).toEqual([
      'managed',
      'managedLists',
      'managedInstitutions',
    ]);
  });

  it('never mixes kinds: "managed" holds associations only, empty groups are dropped', () => {
    const all = [
      org({ slug: 'ecole', type: 'institution' }),
      org({ slug: 'bde' }),
      org({ slug: 'liste', type: 'list' }),
    ];
    expect(rowsOf(all, 'managed')?.map((r) => r.key)).toEqual(['managed-bde']);
    expect(rowsOf(all, 'managedLists')?.map((r) => r.key)).toEqual(['managed-liste']);
    expect(rowsOf(all, 'managedInstitutions')?.map((r) => r.key)).toEqual(['managed-ecole']);
    const only = groups([org({ slug: 'bde' })]).map((g) => g.key);
    expect(only).not.toContain('managedLists');
    expect(only).not.toContain('managedInstitutions');
  });

  it('carries the logo of an organisation, falling back to its kind glyph', () => {
    const rows = rowsOf(
      [org({ slug: 'a', logoUrl: '/api/media/public/1' }), org({ slug: 'b', logoUrl: null })],
      'managed'
    );
    const [a, b] = rows ?? [];
    expect(a.logo?.logoUrl).toBe('/api/media/public/1');
    expect(b.logo?.logoUrl).toBeNull();
    expect(b.icon).toBeDefined();
  });

  it('omits non-managed and archived rows, and the group when nothing is left', () => {
    expect(
      rowsOf([org({ isAdmin: false }), org({ slug: 'old', archived: true })], 'managed')
    ).toBeUndefined();
  });
});
