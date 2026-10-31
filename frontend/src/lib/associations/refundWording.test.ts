import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError, type RefundStanding } from '$lib/associations/api';
import {
  eurosToCents,
  notRefundableHint,
  REFUND_CORE_CODES,
  REFUND_SOCIAL_CODES,
  refundAttemptOf,
  refundEffectMessage,
  refundStateLabel,
  statementLabels,
} from './refundWording';

const standing = (over: Partial<RefundStanding> = {}): RefundStanding => ({
  purchaseRecordId: 'p1',
  refundable: true,
  reason: null,
  withdrawal: 'shop',
  paidCents: 1000,
  refundedCents: 0,
  unconfirmedRefundId: null,
  ...over,
});

describe('a refund attempt, classified by status and code', () => {
  it('a 504 LYDIA_REFUND_UNCONFIRMED is a refund waiting for a check, not a failure', () => {
    const err = new SocialApiError('x', REFUND_CORE_CODES.unconfirmed, 504);
    expect(refundAttemptOf(err)).toEqual({ kind: 'unconfirmed' });
  });

  it('a typed refusal is worded', () => {
    const err = new SocialApiError('x', REFUND_SOCIAL_CODES.exceedsPaid, 409);
    expect(refundAttemptOf(err)).toEqual({
      kind: 'refused',
      message: m.asso_refund_refused_exceeds(),
    });
  });

  it('a refusal Lydia gave with a shared code reads as "Lydia refused"', () => {
    const err = new SocialApiError('x', 'LYDIA_SIGNATURE_REFUSED', 409);
    expect(refundAttemptOf(err)).toEqual({
      kind: 'refused',
      message: m.asso_refund_refused_by_lydia(),
    });
  });

  it('a refund that could not be sent says nothing was refunded', () => {
    const err = new SocialApiError('x', 'PAYMENT_SERVICE_NOT_READY', 503);
    expect(refundAttemptOf(err)).toEqual({
      kind: 'refused',
      message: m.asso_refund_refused_not_sent(),
    });
  });

  it('no answer at all is unknown: the request may have reached the server', () => {
    expect(refundAttemptOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'unknown' });
    expect(refundAttemptOf(new SocialApiError('x', null, 500))).toEqual({ kind: 'unknown' });
  });
});

describe('what the confirmation says a refund withdraws', () => {
  it.each([
    ['membership', m.asso_refund_effect_membership({ buyer: 'Alice' })],
    ['form', m.asso_refund_effect_form({ buyer: 'Alice' })],
    ['form-membership', m.asso_refund_effect_form_membership({ buyer: 'Alice' })],
    ['shop', m.asso_refund_effect_shop()],
    ['topup', m.asso_refund_effect_topup({ buyer: 'Alice' })],
    ['unidentified', m.asso_refund_effect_unidentified()],
  ] as const)('a total refund of a %s payment', (withdrawal, sentence) => {
    expect(refundEffectMessage('total', withdrawal, 'Alice')).toBe(sentence);
  });

  it('a partial refund withdraws nothing, and says so', () => {
    expect(refundEffectMessage('partial', 'membership', 'Alice')).toBe(
      m.asso_refund_effect_partial({ buyer: 'Alice' })
    );
  });
});

describe("a payment's refund state", () => {
  it('is nothing while nothing was refunded', () => {
    expect(refundStateLabel(standing())).toBeNull();
    expect(refundStateLabel(undefined)).toBeNull();
  });
  it('is refunded, or partly refunded with the amount', () => {
    expect(refundStateLabel(standing({ refundedCents: 1000 }))).toBe(
      m.asso_refund_state_refunded()
    );
    expect(refundStateLabel(standing({ refundedCents: 250 }))).toContain('2');
  });
  it('names a refund Lydia has not confirmed before anything else', () => {
    expect(refundStateLabel(standing({ unconfirmedRefundId: 'r1', refundedCents: 250 }))).toBe(
      m.asso_refund_state_unconfirmed()
    );
  });
  it('explains only the refusals worth a sentence', () => {
    expect(notRefundableHint(standing({ refundable: false, reason: 'untraceable' }))).toBe(
      m.asso_refund_untraceable()
    );
    expect(notRefundableHint(standing({ refundable: false, reason: 'not-online' }))).toBeNull();
  });
});

describe('the amount typed', () => {
  it.each([
    ['12', 1200],
    ['12,5', 1250],
    ['0.01', 1],
    [' 3.40 ', 340],
  ])('%j is %i cents', (typed, cents) => {
    expect(eurosToCents(typed)).toBe(cents);
  });
  it.each(['', '0', '-1', '1.234', 'abc', '1e3'])('%j is not an amount', (typed) => {
    expect(eurosToCents(typed)).toBeNull();
  });
});

it('the statement is written in this client words, every one filled', () => {
  const labels = statementLabels();
  expect(Object.keys(labels)).toHaveLength(14);
  for (const value of Object.values(labels)) expect(value).toBeTruthy();
});
