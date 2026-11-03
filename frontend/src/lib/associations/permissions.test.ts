import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_CORE_FLAGS,
  ASSOCIATION_ADMIN_PRESET,
  AssociationPermissionFlag,
  BDE_ONLY_FLAGS,
  SUPER_ADMIN_EXCLUDED_FLAGS,
  ALL_PERMISSION_FLAGS,
  MEMBER_FLAGS_BEYOND_GRANTER,
  grantableFlags,
  findBdeAssociationWithFlag,
  hasPermissionFlag,
  holdsBdeFlag,
  mayActOnAssociation,
  type Association,
} from './api';

const { MANAGE_MEMBERS, MANAGE_ASSO, MANAGE_PAYOUT_ACCOUNT, POST_AS_ASSO, VALIDATE_EVENTS } =
  AssociationPermissionFlag;

/** Only the three fields the predicates read; the rest of `Association` is irrelevant here. */
function asso(id: string, isBDE: boolean, permissions?: number): Association {
  return { id, isBDE, permissions } as Association;
}

describe('mayActOnAssociation', () => {
  it('grants a platform administrator every flag, member or not', () => {
    for (const flag of [MANAGE_MEMBERS, MANAGE_PAYOUT_ACCOUNT, POST_AS_ASSO]) {
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
    ['MANAGE_PAYOUT_ACCOUNT', MANAGE_PAYOUT_ACCOUNT],
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
    expect(SUPER_ADMIN_EXCLUDED_FLAGS).toBe(MANAGE_PAYOUT_ACCOUNT | POST_AS_ASSO);
  });

  it('mirrors the backend ALL_CORE_FLAGS value', () => {
    expect(ALL_CORE_FLAGS).toBe(3359);
    expect(ASSOCIATION_ADMIN_PRESET).toBe(3359 | MANAGE_PAYOUT_ACCOUNT);
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

describe('the role editor', () => {
  /**
   * The members editor is the ONLY screen that grants a flag, and its label list is a `$derived`
   * inside a component, out of a unit test's reach: read the source instead. Dropping a flag's row
   * (as `MANAGE_PARTNERSHIPS` once was) leaves a right that can be handed out and never taken back.
   */
  it('has a FLAG_LABELS row for every flag the enum defines', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/associations/AssociationMemberRow.svelte'
      ),
      'utf8'
    );
    const names = Object.keys(AssociationPermissionFlag).filter((k) => Number.isNaN(Number(k)));
    expect(names).toContain('MANAGE_BOOKINGS');
    for (const name of names) {
      expect(source, `no FLAG_LABELS row for ${name}`).toMatch(
        new RegExp(String.raw`flag:\s*AssociationPermissionFlag\.${name}\b`)
      );
    }
  });

  it('offers only the rights of the entity kind, and toggles a bit without touching the others', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/associations/AssociationMemberRow.svelte'
      ),
      'utf8'
    );
    // The filter is the one derived from the section table, never a list written here.
    expect(source).toMatch(/kindOffersFlag\(kind, flag\)/);
    // A toggle edits ITS bit: a hidden bit already held survives a save.
    expect(source).toMatch(/permissions & ~flag : permissions \| flag/);
  });

  it('disables a box the viewer may not change, and never toggles one', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/associations/AssociationMemberRow.svelte'
      ),
      'utf8'
    );
    expect(source).toMatch(/disabled=\{!mayToggle\}/);
    expect(source).toMatch(/!hasPermissionFlag\(grantable, flag\)\) return;/);
  });
});

describe('grantableFlags - the client mirror of the server grant ceiling', () => {
  const { MANAGE_FORMS } = AssociationPermissionFlag;

  it('gives the platform administrator every flag', () => {
    expect(grantableFlags({ isGlobalAdmin: true, isSuperAdmin: false })).toBe(ALL_PERMISSION_FLAGS);
  });

  it('caps an ordinary member at its own bitmask, and a stranger at nothing', () => {
    const own = MANAGE_MEMBERS | MANAGE_FORMS;
    expect(
      grantableFlags({ isGlobalAdmin: false, isSuperAdmin: false, memberPermissions: own })
    ).toBe(own);
    expect(grantableFlags({ isGlobalAdmin: false, isSuperAdmin: false })).toBe(0);
  });

  it('leaves the super-admin tier uncapped, the excluded flags included (owner, 2026-11-02)', () => {
    const tier = grantableFlags({ isGlobalAdmin: false, isSuperAdmin: true });
    expect(tier).toBe(ALL_PERMISSION_FLAGS);
    expect(tier & SUPER_ADMIN_EXCLUDED_FLAGS).toBe(SUPER_ADMIN_EXCLUDED_FLAGS);
    // ...while the tier still does not EXERCISE them: granting is not inheriting.
    expect(mayActOnAssociation(POST_AS_ASSO, { isGlobalAdmin: false, isSuperAdmin: true })).toBe(
      false
    );
  });

  it('names the same refusal codes and the same tier as the server', () => {
    const server = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        'apps',
        'social-service',
        'src',
        'associations',
        'member-flag-ceiling.ts'
      ),
      'utf8'
    );
    expect(server).toContain(
      `export const MEMBER_FLAGS_BEYOND_GRANTER = '${MEMBER_FLAGS_BEYOND_GRANTER}'`
    );
    expect(server).toMatch(
      /if \(standing\.isGlobalAdmin \|\| standing\.isSuperAdminOf\) return ALL_PERMISSION_FLAGS;/
    );
  });
});
