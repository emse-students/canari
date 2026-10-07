import { of } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import {
  fetchActivePaymentProvider,
  isDelegating,
  resolvePaymentTarget,
} from './payment-delegation.util';
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
    it('uses the association own Lydia account when not delegating', () => {
      const t = resolvePaymentTarget(
        asso({ lydiaAccountId: 'vendor_club', lydiaOnboardingComplete: true }),
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

    it('is not ready when the Lydia onboarding is not complete, an account id notwithstanding', () => {
      const t = resolvePaymentTarget(
        asso({ lydiaAccountId: 'vendor_club', lydiaOnboardingComplete: false }),
        null,
        'lydia'
      );
      expect(t.ready).toBe(false);
    });

    it('never reads the historic stripe columns', () => {
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
        lydiaAccountId: 'vendor_parent',
        lydiaOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent,
        'lydia'
      );
      expect(t).toEqual({
        targetAssociationId: 'parent',
        provider: 'lydia',
        connectAccountId: 'vendor_parent',
        ready: true,
        delegated: true,
      });
    });

    it('routes to the parent even when the club also has its own account (explicit toggle, always to parent)', () => {
      const parent = asso({
        id: 'parent',
        lydiaAccountId: 'vendor_parent',
        lydiaOnboardingComplete: true,
      });
      const t = resolvePaymentTarget(
        asso({
          lydiaAccountId: 'vendor_club',
          lydiaOnboardingComplete: true,
          paymentParentAssociationId: 'parent',
          paymentDelegationStatus: 'approved',
        }),
        parent,
        'lydia'
      );
      expect(t.connectAccountId).toBe('vendor_parent');
      expect(t.delegated).toBe(true);
    });

    it('is not ready when the delegated parent has not finished onboarding', () => {
      const parent = asso({
        id: 'parent',
        lydiaAccountId: 'vendor_parent',
        lydiaOnboardingComplete: false,
      });
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        parent,
        'lydia'
      );
      expect(t.ready).toBe(false);
      expect(t.delegated).toBe(true);
    });

    it('fails closed (not ready, no account) when delegating but the parent could not be loaded', () => {
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'gone', paymentDelegationStatus: 'approved' }),
        null,
        'lydia'
      );
      expect(t).toEqual({
        targetAssociationId: 'gone',
        provider: 'lydia',
        connectAccountId: null,
        ready: false,
        delegated: true,
      });
    });

    it('fails closed when payments are disabled, even for an association with a ready account', () => {
      const t = resolvePaymentTarget(
        asso({ lydiaAccountId: 'vendor_club', lydiaOnboardingComplete: true }),
        null,
        'disabled'
      );
      expect(t).toEqual({
        targetAssociationId: 'club',
        provider: 'disabled',
        connectAccountId: null,
        ready: false,
        delegated: false,
      });
    });

    it('fails closed when payments are disabled, even for a delegation to a ready parent', () => {
      const t = resolvePaymentTarget(
        asso({ paymentParentAssociationId: 'parent', paymentDelegationStatus: 'approved' }),
        asso({
          id: 'parent',
          lydiaAccountId: 'vendor_parent',
          lydiaOnboardingComplete: true,
        }),
        'disabled'
      );
      expect(t).toEqual({
        targetAssociationId: 'parent',
        provider: 'disabled',
        connectAccountId: null,
        ready: false,
        delegated: true,
      });
    });
  });

  describe('fetchActivePaymentProvider', () => {
    const http = (provider: unknown) =>
      ({ get: jest.fn(() => of({ data: { provider } })) }) as unknown as HttpService;

    it('returns the real value for each known provider, disabled included', async () => {
      for (const p of ['lydia', 'disabled'] as const) {
        await expect(fetchActivePaymentProvider(http(p))).resolves.toBe(p);
      }
    });

    it.each(['paypal', 'stripe'])(
      'throws on the unknown value %s instead of guessing',
      async (v) => {
        await expect(fetchActivePaymentProvider(http(v))).rejects.toThrow(
          /unknown payment provider/
        );
      }
    );
  });
});
