import { describe, expect, it } from 'vitest';
import { paymentReturnVerdict } from './paymentReturn';

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
