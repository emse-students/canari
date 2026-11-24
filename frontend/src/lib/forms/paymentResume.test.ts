import { describe, expect, it } from 'vitest';
import { failedPaymentOffer } from './paymentResume';

const answer = { submissionId: 'sub-1', amountCents: 1500 };
const idle = {
  resumable: answer,
  cashSwitchable: null,
  submitted: false,
  paymentPending: false,
  editing: false,
  closed: false,
  notOpenYet: false,
  paymentsPaused: false,
  preview: false,
};

describe('failedPaymentOffer', () => {
  it('offers the resume when the server names a resumable answer and nothing on the page says otherwise', () => {
    expect(failedPaymentOffer(idle)).toEqual({ answer, resume: true, cash: false });
  });

  it('offers both when the server names the answer both ways', () => {
    expect(failedPaymentOffer({ ...idle, cashSwitchable: answer })).toEqual({
      answer,
      resume: true,
      cash: true,
    });
  });

  it('offers cash only when the form takes no online payment for it', () => {
    expect(failedPaymentOffer({ ...idle, resumable: null, cashSwitchable: answer })).toEqual({
      answer,
      resume: false,
      cash: true,
    });
  });

  // Cash never reaches an account: paused online payments stop the resume, never the cash.
  it('keeps the cash offer while online payments are paused, and drops the resume', () => {
    expect(failedPaymentOffer({ ...idle, cashSwitchable: answer, paymentsPaused: true })).toEqual({
      answer,
      resume: false,
      cash: true,
    });
    expect(failedPaymentOffer({ ...idle, paymentsPaused: true })).toBeNull();
  });

  it('offers nothing when the server names none, or is older and sends no field', () => {
    expect(failedPaymentOffer({ ...idle, resumable: null })).toBeNull();
    expect(
      failedPaymentOffer({ ...idle, resumable: undefined, cashSwitchable: undefined })
    ).toBeNull();
  });

  it.each([
    ['an answer sent on this screen', { submitted: true }],
    ['a payment started on this screen', { paymentPending: true }],
    ['an answer being changed', { editing: true }],
    ['a form that closed while the page was open', { closed: true }],
    ['a form not open yet', { notOpenYet: true }],
    ['a preview', { preview: true }],
  ])('offers nothing for %s', (_why, patch) => {
    expect(failedPaymentOffer({ ...idle, cashSwitchable: answer, ...patch })).toBeNull();
  });
});
