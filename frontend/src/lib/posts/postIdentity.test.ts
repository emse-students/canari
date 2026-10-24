import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/associations/api', () => ({
  listAssociations: vi.fn(),
  listMyAssociations: vi.fn(),
  // The real flag values: POST_AS_ASSO is bit 0.
  AssociationPermissionFlag: { POST_AS_ASSO: 1 },
  hasPermissionFlag: (permissions: number, flag: number) => (permissions & flag) !== 0,
}));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false }));

import {
  commentIdentityFields,
  commentIdentityOf,
  isAssociationIdentity,
  listPostAsAssociations,
  postIdentityFields,
} from './postIdentity';
import { listMyAssociations } from '$lib/associations/api';
import type { Association } from '$lib/associations/api';
import { ANONYMOUS_POST_IDENTITY } from './postComposerDraft';

describe('postIdentity', () => {
  it('only an association id publishes as an association: anonymity is a personal post', () => {
    expect(isAssociationIdentity('')).toBe(false);
    expect(isAssociationIdentity(ANONYMOUS_POST_IDENTITY)).toBe(false);
    expect(isAssociationIdentity('3f0c-asso')).toBe(true);
  });

  it('maps each choice to its payload fields', () => {
    expect(postIdentityFields('')).toEqual({});
    expect(postIdentityFields(ANONYMOUS_POST_IDENTITY)).toEqual({ anonymous: true });
    expect(postIdentityFields('3f0c-asso')).toEqual({ associationId: '3f0c-asso' });
  });
});

const asso = (id: string, permissions?: number) =>
  ({
    id,
    name: `Asso ${id}`,
    slug: id,
    logoUrl: null,
    permissions,
    isAdmin: (permissions ?? 0) > 0,
  }) as Association;

describe('who may be offered as a poster', () => {
  it('lists only the associations where the member holds POST_AS_ASSO, not any permission', async () => {
    vi.mocked(listMyAssociations).mockResolvedValue([
      asso('speaks', 1),
      asso('roster-only', 2),
      asso('speaks-and-more', 3),
      asso('member', 0),
      asso('unknown'),
    ]);
    const offered = await listPostAsAssociations();
    expect(offered.map((a) => a.id)).toEqual(['speaks', 'speaks-and-more']);
  });
});

describe('comment identity', () => {
  const offered = [asso('a1', 1)];

  it('maps each identity to the payload fields', () => {
    expect(commentIdentityFields({ kind: 'personal' })).toEqual({});
    expect(commentIdentityFields({ kind: 'anonymous' })).toEqual({ anonymous: true });
    expect(commentIdentityFields({ kind: 'association', association: offered[0] })).toEqual({
      associationId: 'a1',
    });
  });

  it('reads the picker value against the offered associations', () => {
    expect(commentIdentityOf('', offered)).toEqual({ kind: 'personal' });
    expect(commentIdentityOf(ANONYMOUS_POST_IDENTITY, offered)).toEqual({ kind: 'anonymous' });
    expect(commentIdentityOf('a1', offered)).toEqual({
      kind: 'association',
      association: offered[0],
    });
  });

  it('refuses an association that was not offered, instead of falling back to the member', () => {
    expect(commentIdentityOf('ghost', offered)).toBeNull();
  });
});
