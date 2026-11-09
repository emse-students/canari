import { Logger } from '@nestjs/common';
import {
  AssociationPermissionFlag as F,
  TYPE_EXCLUDED_FLAGS,
} from './entities/association-member.entity';
import {
  ASSOCIATION_KIND_DOES_NOT_SELL,
  LIST_DELEGATE_REQUIRED,
  LIST_NO_OWN_LYDIA_ACCOUNT,
  assertMayCollect,
  assertMayHoldOwnAccount,
  assertMayRequestDelegation,
  collectionModeOf,
  mayCollect,
  writablePermissions,
} from './collection-policy';

const logger = new Logger('collection-policy.spec');
beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

const approved = {
  paymentParentAssociationId: 'receiver',
  paymentDelegationStatus: 'approved' as const,
};
const pending = {
  paymentParentAssociationId: 'receiver',
  paymentDelegationStatus: 'pending' as const,
};
const none = { paymentParentAssociationId: null, paymentDelegationStatus: null };

describe('collection policy (owner, 2026-11-02)', () => {
  it('derives each kind mode from TYPE_EXCLUDED_FLAGS, and closes an unknown kind', () => {
    expect(collectionModeOf('association')).toBe('own-account');
    expect(collectionModeOf('list')).toBe('delegate-only');
    expect(collectionModeOf('institution')).toBe('never');
    expect(collectionModeOf('anything-new')).toBe('never');
  });

  it('pins the per-kind table: a list loses the payout account only, an institution both', () => {
    expect(TYPE_EXCLUDED_FLAGS).toEqual({
      association: 0,
      list: F.MANAGE_PAYOUT_ACCOUNT,
      institution: F.MANAGE_PRODUCTS | F.MANAGE_PAYOUT_ACCOUNT,
    });
  });

  describe('mayCollect - the one predicate', () => {
    it('lets an association collect, delegating or not', () => {
      expect(mayCollect({ type: 'association', ...none })).toBe(true);
      expect(mayCollect({ type: 'association', ...pending })).toBe(true);
      expect(mayCollect({ type: 'association', ...approved })).toBe(true);
    });

    it('lets a list collect only through an APPROVED delegation', () => {
      expect(mayCollect({ type: 'list', ...approved })).toBe(true);
      expect(mayCollect({ type: 'list', ...pending })).toBe(false);
      expect(mayCollect({ type: 'list', ...none })).toBe(false);
    });

    it('never lets an institution collect, even with a delegation row', () => {
      expect(mayCollect({ type: 'institution', ...none })).toBe(false);
      expect(mayCollect({ type: 'institution', ...approved })).toBe(false);
    });
  });

  describe('assertMayCollect - one typed refusal per mode', () => {
    it('refuses a list without an approved delegate with LIST_DELEGATE_REQUIRED', () => {
      expect(() =>
        assertMayCollect(logger, { id: 'list-1', type: 'list', ...pending }, 'product create')
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: LIST_DELEGATE_REQUIRED }),
        })
      );
    });

    it('refuses an institution with ASSOCIATION_KIND_DOES_NOT_SELL', () => {
      expect(() =>
        assertMayCollect(logger, { id: 'inst-1', type: 'institution', ...none }, 'form price')
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ASSOCIATION_KIND_DOES_NOT_SELL }),
        })
      );
    });

    it('lets a delegating list and any association through', () => {
      expect(() =>
        assertMayCollect(logger, { id: 'list-1', type: 'list', ...approved }, 'product create')
      ).not.toThrow();
      expect(() =>
        assertMayCollect(logger, { id: 'a-1', type: 'association', ...none }, 'product create')
      ).not.toThrow();
    });
  });

  it('opens the delegation REQUEST to a list, never to an institution', () => {
    expect(() => assertMayRequestDelegation(logger, 'list-1', 'list')).not.toThrow();
    expect(() => assertMayRequestDelegation(logger, 'a-1', 'association')).not.toThrow();
    expect(() => assertMayRequestDelegation(logger, 'inst-1', 'institution')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: ASSOCIATION_KIND_DOES_NOT_SELL }),
      })
    );
  });

  it('lets only an association hold an account of its own (receive a delegation, link a Lydia)', () => {
    expect(() => assertMayHoldOwnAccount(logger, 'a-1', 'association', 'x')).not.toThrow();
    expect(() => assertMayHoldOwnAccount(logger, 'list-1', 'list', 'x')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: LIST_NO_OWN_LYDIA_ACCOUNT }),
      })
    );
    expect(() => assertMayHoldOwnAccount(logger, 'inst-1', 'institution', 'x')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: ASSOCIATION_KIND_DOES_NOT_SELL }),
      })
    );
  });

  describe('writablePermissions', () => {
    const all = F.MANAGE_MEMBERS | F.MANAGE_FORMS | F.MANAGE_PRODUCTS | F.MANAGE_PAYOUT_ACCOUNT;

    it('keeps the shop of a list and strips only its payout account', () => {
      expect(writablePermissions('list', all)).toBe(
        F.MANAGE_MEMBERS | F.MANAGE_FORMS | F.MANAGE_PRODUCTS
      );
    });

    it('strips both from an institution', () => {
      expect(writablePermissions('institution', all)).toBe(F.MANAGE_MEMBERS | F.MANAGE_FORMS);
    });

    it('leaves an association bitmask whole', () => {
      expect(writablePermissions('association', all)).toBe(all);
    });

    it('keeps EDIT_PROFILE on every kind: a list and an institution have a profile too', () => {
      for (const type of ['association', 'list', 'institution']) {
        expect(writablePermissions(type, F.EDIT_PROFILE | F.MANAGE_PRODUCTS) & F.EDIT_PROFILE).toBe(
          F.EDIT_PROFILE
        );
      }
    });
  });
});
