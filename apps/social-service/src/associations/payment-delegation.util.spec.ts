import { isDelegating, resolvePaymentTarget } from './payment-delegation.util';
import type { Association } from './entities/association.entity';

const asso = (o: Partial<Association> = {}): Association =>
  ({
    id: 'club',
    stripeAccountId: null,
    stripeOnboardingComplete: false,
    lydiaAccountId: null,
    lydiaOnboardingComplete: false,
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
    it('uses the association own Stripe account when not delegating and Stripe is active', () => {
      const t = resolvePaymentTarget(
        asso({ stripeAccountId: 'acct_club', stripeOnboardingComplete: true }),
        null,
        'stripe'
      );
      expect(t).toEqual({
        targetAssociationId: 'club',
        provider: 'stripe',
        connectAccountId: 'acct_club',
        ready: true,
        delegated: false,
      });
    });

    it('uses the association own Lydia account when not delegating and Lydia is active', () => {
      const t = resolvePaymentTarget(
        asso({
          stripeAccountId: 'acct_club',
          stripeOnboardingComplete: true,
          lydiaAccountId: 'vendor_club',
          lydiaOnboardingComplete: true,
        }),
        null,
        'lydia'
      );
      expect(t).toEqual({
        targetAssociationId: 'club',
        provider: 'lydia',
        connectAccountId: 'vendor_club',
        ready: true,
        delegated: false,
      });
    });

    it('is not ready when the association onboarded Stripe but Lydia is the active provider', () => {
      const t = resolvePaymentTarget(
        asso({ stripeAccountId: 'acct_club', stripeOnboardingComplete: true }),
        null,
        'lydia'
      );
      expect(t.connectAccountId).toBeNull();
      expect(t.ready).toBe(false);
    });

    it('routes to the parent account when delegation is approved', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent,
        'stripe'
      );
      expect(t).toEqual({
        targetAssociationId: 'parent',
        provider: 'stripe',
        connectAccountId: 'acct_parent',
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
        parent,
        'stripe'
      );
      expect(t.connectAccountId).toBe('acct_parent');
      expect(t.delegated).toBe(true);
    });

    it('is not ready when the delegated parent has not finished onboarding for the active provider', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: false,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent,
        'stripe'
      );
      expect(t.ready).toBe(false);
      expect(t.delegated).toBe(true);
    });

    it('is not ready when the delegated parent onboarded the other provider only', () => {
      const parent = asso({
        id: 'parent',
        stripeAccountId: 'acct_parent',
        stripeOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent,
        'lydia'
      );
      expect(t.connectAccountId).toBeNull();
      expect(t.ready).toBe(false);
      expect(t.delegated).toBe(true);
    });

    it('fails closed (not ready, no account) when delegating but the parent could not be loaded', () => {
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'gone', paymentDelegationStatus: 'approved' }),
        null,
        'stripe'
      );
      expect(t).toEqual({
        targetAssociationId: 'gone',
        provider: 'stripe',
        connectAccountId: null,
        ready: false,
        delegated: true,
      });
    });
  });
});
