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

function managed(memberships: Association[]) {
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
  return dashboardHubGroups(facts, { signOut: () => {} }).find((g) => g.key === 'managed');
}

describe('dashboard managed group', () => {
  it('splits associations, lists and institutions, in that order, dropping empty ones', () => {
    const group = managed([
      org({ slug: 'ecole', type: 'institution' }),
      org({ slug: 'bde' }),
      org({ slug: 'liste', type: 'list', promo: 2026 }),
    ]);
    expect(group?.sections?.map((s) => s.key)).toEqual(['assos', 'lists', 'institutions']);
    expect(managed([org({ slug: 'bde' })])?.sections?.map((s) => s.key)).toEqual(['assos']);
  });

  it('carries the logo of an organisation, falling back to its kind glyph', () => {
    const group = managed([
      org({ slug: 'a', logoUrl: '/api/media/public/1' }),
      org({ slug: 'b', logoUrl: null }),
    ]);
    const [a, b] = group?.rows ?? [];
    expect(a.logo?.logoUrl).toBe('/api/media/public/1');
    expect(b.logo?.logoUrl).toBeNull();
    expect(b.icon).toBeDefined();
  });

  it('omits non-managed and archived rows, and the group when nothing is left', () => {
    expect(
      managed([org({ isAdmin: false }), org({ slug: 'old', archived: true })])
    ).toBeUndefined();
  });
});
