import { describe, expect, it } from 'vitest';
import { offersPaymentResume } from './paymentResume';

const resumable = { submissionId: 'sub-1', amountCents: 1500 };
const idle = {
  resumable,
  submitted: false,
  paymentPending: false,
  editing: false,
  closed: false,
  notOpenYet: false,
  paymentsPaused: false,
  preview: false,
};

describe('offersPaymentResume', () => {
  it('offers the resume when the server names a resumable answer and nothing on the page says otherwise', () => {
    expect(offersPaymentResume(idle)).toBe(true);
  });

  it('offers nothing when the server names none, or is older and sends no field', () => {
    expect(offersPaymentResume({ ...idle, resumable: null })).toBe(false);
    expect(offersPaymentResume({ ...idle, resumable: undefined })).toBe(false);
  });

  it.each([
    ['an answer sent on this screen', { submitted: true }],
    ['a payment started on this screen', { paymentPending: true }],
    ['an answer being changed', { editing: true }],
    ['a form that closed while the page was open', { closed: true }],
    ['a form not open yet', { notOpenYet: true }],
    ['online payments paused', { paymentsPaused: true }],
    ['a preview', { preview: true }],
  ])('offers nothing for %s', (_why, patch) => {
    expect(offersPaymentResume({ ...idle, ...patch })).toBe(false);
  });

  // A promoted answer owing its payment (the waiting list): answered already, its seat its own.
  it('offers the payment of a promoted answer although it is answered and the form closed', () => {
    expect(offersPaymentResume({ ...idle, submitted: true, closed: true, paymentDue: true })).toBe(
      true
    );
    expect(offersPaymentResume({ ...idle, submitted: true, paymentDue: true, preview: true })).toBe(
      false
    );
  });
});
