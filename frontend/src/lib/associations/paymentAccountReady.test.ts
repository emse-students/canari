import { describe, expect, it } from 'vitest';
import { canAssociationReceiveFormPayments, isPaymentAccountReady } from './api';

/**
 * THE FLAG IS LYDIA'S, AND ONLY LYDIA'S. The edit screens once read `stripeOnboardingComplete`, so
 * an association whose Lydia onboarding was complete in the database showed as incomplete (2026-10-03).
 * Stripe has left the product: its historic flag is never read, whatever it says.
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
    expect(canAssociationReceiveFormPayments(asso, 'disabled')).toBe(false);
  });
});
