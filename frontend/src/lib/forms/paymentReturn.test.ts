import { describe, expect, it } from 'vitest';
import { paymentCancelView, paymentReturnVerdict } from './paymentReturn';

describe('paymentCancelView', () => {
  it.each([
    // The callback (or the cancel's own state read) found the request paid: never "cancelled".
    ['paid', 'paid'],
    ['paid_over_capacity', 'overCapacity'],
    ['pending', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['expired', 'cancelled'],
  ])('%j shows %s', (status, view) => {
    expect(paymentCancelView(status)).toBe(view);
  });
});

describe('paymentReturnVerdict', () => {
  it.each([
    ['paid', 'confirmed'],
    ['free', 'confirmed'],
    ['pending', 'wait'],
    ['cancelled', 'failed'],
    // A seat released while the payer was still paying: a late payment may still land.
    ['expired', 'wait'],
    ['paid_over_capacity', 'overCapacity'],
    ['pending_cash', 'failed'],
    ['', 'failed'],
  ])('%j is %s', (status, verdict) => {
    expect(paymentReturnVerdict(status)).toBe(verdict);
  });
});
