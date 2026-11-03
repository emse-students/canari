import { describe, expect, it } from 'vitest';
import {
  canAssociationReceiveFormPayments,
  canTakePayments,
  isPaymentAccountReady,
  keepPaymentsReady,
} from './api';

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

  // G4 (owner, 2026-11-02): whether an entity can TAKE a payment is the server's `paymentsReady` -
  // its own Lydia OR its approved delegate's. A delegating association, and every collecting list,
  // has no own flag; reading it told them "payments not configured" while they collected.
  it('gates paid forms on the server-resolved readiness, delegation included', () => {
    type A = Parameters<typeof canAssociationReceiveFormPayments>[0];
    const delegating = { lydiaOnboardingComplete: false, paymentsReady: true } as A;
    expect(canAssociationReceiveFormPayments(delegating, 'lydia')).toBe(true);
    expect(canTakePayments(delegating, 'lydia')).toBe(true);
    expect(canAssociationReceiveFormPayments(delegating, 'disabled')).toBe(false);
    // Its OWN account stays unready: the delegation tab's "can receive" check reads that one.
    expect(isPaymentAccountReady(delegating, 'lydia')).toBe(false);
    const paused = { lydiaOnboardingComplete: false, paymentsReady: false } as A;
    expect(canTakePayments(paused, 'lydia')).toBe(false);
    // A row with no resolution (a write's echo) is never ready by guess.
    expect(canTakePayments({ lydiaOnboardingComplete: true } as A, 'lydia')).toBe(false);
  });

  it('keeps the previous resolution across a profile write', () => {
    const before = { id: 'a', paymentsReady: true } as Parameters<typeof keepPaymentsReady>[0];
    const echoed = { id: 'a' } as Parameters<typeof keepPaymentsReady>[0];
    expect(keepPaymentsReady(echoed, before).paymentsReady).toBe(true);
    expect(keepPaymentsReady({ ...echoed, paymentsReady: false }, before).paymentsReady).toBe(
      false
    );
  });
});
