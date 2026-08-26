import { describe, expect, it } from 'vitest';
import {
  ALL_CORE_FLAGS,
  ASSOCIATION_ADMIN_PRESET,
  AssociationPermissionFlag,
  BDE_ONLY_FLAGS,
  SUPER_ADMIN_EXCLUDED_FLAGS,
  findBdeAssociationWithFlag,
  hasPermissionFlag,
  holdsBdeFlag,
  mayActOnAssociation,
  type Association,
} from './api';

const { MANAGE_MEMBERS, MANAGE_ASSO, MANAGE_STRIPE_CONNECT, POST_AS_ASSO, VALIDATE_EVENTS } =
  AssociationPermissionFlag;

/** Only the three fields the predicates read; the rest of `Association` is irrelevant here. */
function asso(id: string, isBDE: boolean, permissions?: number): Association {
  return { id, isBDE, permissions } as Association;
}

describe('mayActOnAssociation', () => {
  it('grants a platform administrator every flag, member or not', () => {
    for (const flag of [MANAGE_MEMBERS, MANAGE_STRIPE_CONNECT, POST_AS_ASSO]) {
      expect(
        mayActOnAssociation(flag, {
          isGlobalAdmin: true,
          isSuperAdmin: false,
          memberPermissions: undefined,
        })
      ).toBe(true);
    }
  });

  it('refuses a non-member with no tier', () => {
    expect(
      mayActOnAssociation(MANAGE_MEMBERS, {
        isGlobalAdmin: false,
        isSuperAdmin: false,
        memberPermissions: undefined,
      })
    ).toBe(false);
  });

  it('judges a plain member on their bitmask alone', () => {
    const ctx = { isGlobalAdmin: false, isSuperAdmin: false };
    expect(mayActOnAssociation(MANAGE_MEMBERS, { ...ctx, memberPermissions: MANAGE_MEMBERS })).toBe(
      true
    );
    expect(mayActOnAssociation(MANAGE_MEMBERS, { ...ctx, memberPermissions: POST_AS_ASSO })).toBe(
      false
    );
  });

  it('grants a BDE super-admin an administration right they do not hold locally', () => {
    expect(mayActOnAssociation(MANAGE_MEMBERS, { isGlobalAdmin: false, isSuperAdmin: true })).toBe(
      true
    );
  });

  // These two are the whole point of sharing one predicate: the edit page used to spell the
  // Stripe exception out by hand, so the exception and the rule could drift apart.
  it.each([
    ['MANAGE_STRIPE_CONNECT', MANAGE_STRIPE_CONNECT],
    ['POST_AS_ASSO', POST_AS_ASSO],
  ])('withholds %s from a BDE super-admin', (_name, flag) => {
    expect(mayActOnAssociation(flag, { isGlobalAdmin: false, isSuperAdmin: true })).toBe(false);
    // ... but never from the association's own holder of it.
    expect(
      mayActOnAssociation(flag, {
        isGlobalAdmin: false,
        isSuperAdmin: true,
        memberPermissions: flag,
      })
    ).toBe(true);
  });
});

describe('BDE-wide flag lookup', () => {
  const mine = [asso('club', false, MANAGE_ASSO | VALIDATE_EVENTS), asso('bde', true, MANAGE_ASSO)];

  it('names the BDE association carrying the flag, not just the verdict', () => {
    expect(findBdeAssociationWithFlag(mine, MANAGE_ASSO)?.id).toBe('bde');
    expect(holdsBdeFlag(mine, MANAGE_ASSO)).toBe(true);
  });

  it('ignores the same flag held in a non-BDE association', () => {
    expect(findBdeAssociationWithFlag(mine, VALIDATE_EVENTS)).toBeUndefined();
    expect(holdsBdeFlag(mine, VALIDATE_EVENTS)).toBe(false);
  });

  it('treats a withheld bitmask as no flags rather than guessing', () => {
    expect(holdsBdeFlag([asso('bde', true, undefined)], MANAGE_ASSO)).toBe(false);
  });
});

describe('the constants the server also defines', () => {
  it('keeps the super-admin exclusion set to the two flags that are not administration', () => {
    expect(SUPER_ADMIN_EXCLUDED_FLAGS).toBe(MANAGE_STRIPE_CONNECT | POST_AS_ASSO);
  });

  it('mirrors the backend ALL_CORE_FLAGS value', () => {
    expect(ALL_CORE_FLAGS).toBe(1311);
    expect(ASSOCIATION_ADMIN_PRESET).toBe(1311 | MANAGE_STRIPE_CONNECT);
  });

  it('lists exactly the three flags the server gates on a.isBDE', () => {
    expect([...BDE_ONLY_FLAGS].sort((a, b) => a - b)).toEqual([
      VALIDATE_EVENTS,
      MANAGE_ASSO,
      AssociationPermissionFlag.MODERATE,
    ]);
  });

  /**
   * Every core flag must be grantable from the members editor. `MANAGE_PARTNERSHIPS` was in the
   * preset and in `ALL_CORE_FLAGS` but absent from that editor's label list, so it could be handed
   * out on creation and never afterwards seen or revoked.
   */
  it('has the admin preset cover every non-BDE flag', () => {
    const nonBde = Object.values(AssociationPermissionFlag)
      .filter((v): v is AssociationPermissionFlag => typeof v === 'number')
      .filter((flag) => !BDE_ONLY_FLAGS.has(flag));
    for (const flag of nonBde) {
      expect(hasPermissionFlag(ASSOCIATION_ADMIN_PRESET, flag)).toBe(true);
    }
  });
});
