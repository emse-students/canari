import { describe, expect, it } from 'vitest';
import { paymentReturnVerdict } from './paymentReturn';

describe('paymentReturnVerdict', () => {
  it.each([
    ['paid', 'confirmed'],
    ['free', 'confirmed'],
    ['pending', 'wait'],
    ['cancelled', 'failed'],
    ['expired', 'failed'],
    ['pending_cash', 'failed'],
    ['', 'failed'],
  ])('%j is %s', (status, verdict) => {
    expect(paymentReturnVerdict(status)).toBe(verdict);
  });
});
