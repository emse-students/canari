import { describe, expect, it } from 'vitest';
import { canAssociationReceiveFormPayments, isPaymentAccountReady } from './api';

/**
 * THE FLAG IS THE ACTIVE PROVIDER'S (2026-10-03). The edit screens read `stripeOnboardingComplete`
 * only, so an association whose Lydia onboarding was complete in the database still showed as
 * incomplete: its boutique and forms warned, and it could not receive paid forms or a delegation.
 */
const flags = (stripe: boolean, lydia: boolean) => ({
  stripeOnboardingComplete: stripe,
  lydiaOnboardingComplete: lydia,
});

describe('isPaymentAccountReady', () => {
  it('reads the Lydia flag while Lydia is active', () => {
    expect(isPaymentAccountReady(flags(false, true), 'lydia')).toBe(true);
    expect(isPaymentAccountReady(flags(true, false), 'lydia')).toBe(false);
  });

  it('reads the Stripe flag while Stripe is active', () => {
    expect(isPaymentAccountReady(flags(true, false), 'stripe')).toBe(true);
    expect(isPaymentAccountReady(flags(false, true), 'stripe')).toBe(false);
  });

  it('is never ready while the provider is unknown', () => {
    expect(isPaymentAccountReady(flags(true, true), null)).toBe(false);
  });

  it('is never ready while the platform declares payments disabled, whatever the flags say', () => {
    expect(isPaymentAccountReady(flags(true, true), 'disabled')).toBe(false);
    expect(isPaymentAccountReady(flags(true, false), 'disabled')).toBe(false);
    expect(isPaymentAccountReady(flags(false, true), 'disabled')).toBe(false);
  });

  it('gates paid forms on the same answer', () => {
    const asso = flags(false, true) as Parameters<typeof canAssociationReceiveFormPayments>[0];
    expect(canAssociationReceiveFormPayments(asso, 'lydia')).toBe(true);
    expect(canAssociationReceiveFormPayments(asso, 'stripe')).toBe(false);
  });
});
