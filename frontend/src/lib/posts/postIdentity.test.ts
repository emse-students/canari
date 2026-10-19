import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/associations/api', () => ({
  listAssociations: vi.fn(),
  listMyAssociations: vi.fn(),
}));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false }));

import { isAssociationIdentity, postIdentityFields } from './postIdentity';
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
