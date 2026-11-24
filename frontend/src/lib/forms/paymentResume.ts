import type { ResumableAnswer } from '$lib/forms/api';

/** What the form page offers for an answer whose card payment failed, cancelled or expired. */
export interface FailedPaymentOffer {
  /** The answer both actions are about: the same row, its own amount. */
  answer: ResumableAnswer;
  /** "Reprendre le paiement": the SAME answer paid online again, through a new Lydia request. */
  resume: boolean;
  /** "Payer en direct": the SAME answer settled in person instead, validated by the organiser. */
  cash: boolean;
}

/**
 * WHAT THE FORM PAGE OFFERS FOR A FAILED CARD PAYMENT (owner decisions of 2026-11-21 and
 * 2026-11-23; forms.md, "A released payment is resumed on the same answer" and "A failed card
 * payment is settled in person instead").
 *
 * The server decides what may be offered - the answer's status, the form open, a free seat, online
 * or cash accepted - and names it in `GET forms/:id/check` (`resumable`, `cashSwitchable`). The page
 * adds only what IT knows since: an answer sent or a payment started on this screen, a change being
 * edited, a form that closed while the page was open, a preview - and online payments paused, which
 * stop the resume and NOT the cash (cash never reaches an account). Null when nothing is offered.
 * Nothing here is a clock.
 *
 * A PROMOTED ANSWER OWING ITS PAYMENT (`paymentDue`, the waiting list of 2026-11-23) is a
 * registration already - so the page counts it as answered - and holds its own seat whatever the
 * form's window: neither "answered" nor "closed" withholds its payment.
 */
export function failedPaymentOffer(state: {
  resumable: ResumableAnswer | null | undefined;
  cashSwitchable: ResumableAnswer | null | undefined;
  submitted: boolean;
  /** The caller's answer is a promoted one whose payment is owed (`payment_due`). */
  paymentDue?: boolean;
  paymentPending: boolean;
  editing: boolean;
  closed: boolean;
  notOpenYet: boolean;
  paymentsPaused: boolean;
  preview: boolean;
}): FailedPaymentOffer | null {
  const due = !!state.paymentDue;
  if (
    (state.submitted && !due) ||
    state.paymentPending ||
    state.editing ||
    ((state.closed || state.notOpenYet) && !due) ||
    state.preview
  ) {
    return null;
  }
  const resume = !!state.resumable && !state.paymentsPaused;
  const cash = !!state.cashSwitchable;
  const answer = resume ? state.resumable : state.cashSwitchable;
  if (!answer || (!resume && !cash)) return null;
  return { answer, resume, cash };
}
