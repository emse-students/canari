import { describe, expect, it } from 'vitest';
import { isRetryableVerdict, paymentCancelView, paymentReturnVerdict } from './paymentReturn';

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

  // P1-a (2026-10-21): a decline used to read as `pending` -> "wait", with no retry, for up to 30
  // minutes. The server now reads the request and says so; the page offers the retry.
  it.each([
    ['cancelled', 'declined', 'declined'],
    ['cancelled', 'cancelled-or-expired', 'ended'],
    // An `expired` row whose request is dead: nothing can land any more, the payer may retry.
    ['expired', 'cancelled-or-expired', 'ended'],
    ['pending', 'open', 'wait'],
    ['pending', 'unknown', 'wait'],
    // Review of #2210: a still-pending row waits on ANOTHER request than the dead one read (a
    // retry replaced it): never "try again", which would cancel the request being paid.
    ['pending', 'declined', 'wait'],
    ['pending', 'cancelled-or-expired', 'wait'],
    // A payment always wins over a stale state read.
    ['paid', 'declined', 'confirmed'],
    ['paid_over_capacity', 'cancelled-or-expired', 'overCapacity'],
  ] as const)('%j with a request %s is %s', (status, state, verdict) => {
    expect(paymentReturnVerdict(status, state)).toBe(verdict);
  });

  it('offers a retry on a dead request only', () => {
    expect(isRetryableVerdict('declined')).toBe(true);
    expect(isRetryableVerdict('ended')).toBe(true);
    expect(isRetryableVerdict('wait')).toBe(false);
    expect(isRetryableVerdict('failed')).toBe(false);
  });
});
