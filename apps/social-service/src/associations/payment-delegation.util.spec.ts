import { isDelegating, resolvePaymentTarget } from './payment-delegation.util';
import type { Association } from './entities/association.entity';

const asso = (o: Partial<Association> = {}): Association =>
  ({
    id: 'club',
    stripeAccountId: null,
    stripeOnboardingComplete: false,
    paymentParentAssociationId: null,
    paymentDelegationStatus: null,
    ...o,
  }) as Association;

describe('payment-delegation util', () => {
  describe('isDelegating', () => {
    it('is true only when a parent is set AND the status is approved', () => {
      expect(
        isDelegating(asso({ paymentParentAssociationId: 'p', paymentDelegationStatus: 'approved' }))
      ).toBe(true);
      expect(
        isDelegating(asso({ paymentParentAssociationId: 'p', paymentDelegationStatus: 'pending' }))
      ).toBe(false);
      expect(
        isDelegating(
          asso({ paymentParentAssociationId: null, paymentDelegationStatus: 'approved' })
        )
      ).toBe(false);
      expect(isDelegating(asso())).toBe(false);
    });
  });

  describe('resolvePaymentTarget', () => {
    it('uses the association own account when not delegating', () => {
      const t = resolvePaymentTarget(
        asso({ stripeAccountId: 'acct_club', stripeOnboardingComplete: true }),
        null
      );
      expect(t).toEqual({
        targetAssociationId: 'club',
        stripeAccountId: 'acct_club',
        ready: true,
        delegated: false,
      });
    });

    it('routes to the parent account when delegation is approved', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent
      );
      expect(t).toEqual({
        targetAssociationId: 'parent',
        stripeAccountId: 'acct_parent',
        ready: true,
        delegated: true,
      });
    });

    it('routes to the parent even when the club also has its own account (explicit toggle, always to parent)', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({
          stripeAccountId: 'acct_club',
          stripeOnboardingComplete: true,
          paymentParentAssociationId: 'parent',
          paymentDelegationStatus: 'approved',
        }),
        parent
      );
      expect(t.stripeAccountId).toBe('acct_parent');
      expect(t.delegated).toBe(true);
    });

    it('is not ready when the delegated parent has not finished onboarding', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: false,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent
      );
      expect(t.ready).toBe(false);
      expect(t.delegated).toBe(true);
    });

    it('fails closed (not ready, no account) when delegating but the parent could not be loaded', () => {
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'gone', paymentDelegationStatus: 'approved' }),
        null
      );
      expect(t).toEqual({
        targetAssociationId: 'gone',
        stripeAccountId: null,
        ready: false,
        delegated: true,
      });
    });
  });
});
