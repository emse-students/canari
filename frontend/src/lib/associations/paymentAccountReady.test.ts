import { describe, expect, it } from 'vitest';
import { canAssociationReceiveFormPayments, isPaymentAccountReady } from './api';

/**
 * THE FLAG IS LYDIA'S, AND ONLY LYDIA'S. The edit screens once read `stripeOnboardingComplete`, so
 * an association whose Lydia onboarding was complete in the database showed as incomplete (2026-10-03).
 * Stripe has left the product and the server no longer sends its historic flag at all (2026-10-09).
 */
const flags = (lydia: boolean) => ({ lydiaOnboardingComplete: lydia });

describe('isPaymentAccountReady', () => {
  it('reads the Lydia flag while Lydia is active', () => {
    expect(isPaymentAccountReady(flags(true), 'lydia')).toBe(true);
    expect(isPaymentAccountReady(flags(false), 'lydia')).toBe(false);
  });

  it('is never ready while the provider is unknown', () => {
    expect(isPaymentAccountReady(flags(true), null)).toBe(false);
  });

  it('is never ready while the platform declares payments disabled, whatever the flag says', () => {
    expect(isPaymentAccountReady(flags(true), 'disabled')).toBe(false);
    expect(isPaymentAccountReady(flags(false), 'disabled')).toBe(false);
  });

  it('gates paid forms on the same answer', () => {
    const asso = flags(true) as Parameters<typeof canAssociationReceiveFormPayments>[0];
    expect(canAssociationReceiveFormPayments(asso, 'lydia')).toBe(true);
    expect(canAssociationReceiveFormPayments(asso, 'disabled')).toBe(false);
  });
});
