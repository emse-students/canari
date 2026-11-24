import { m } from '$lib/paraglide/messages';

/** What a form submission's payment status means for the page the payer lands on after Lydia. */
export type PaymentReturnVerdict =
  | 'confirmed'
  | 'wait'
  | 'overCapacity'
  | 'declined'
  | 'ended'
  | 'cash'
  | 'failed';

/**
 * A payment request's state as the server read it from the provider on THIS call
 * (`confirm-payment`'s `requestState`, typed by core-service at the provider boundary). Absent when
 * nothing was read.
 */
export type PaymentRequestState = 'open' | 'paid' | 'declined' | 'cancelled-or-expired' | 'unknown';

/**
 * `pending` and `expired` can still change: the signed Lydia callback may arrive after the browser
 * redirect, and an online `expired` row is one whose seat was released while the payer was still
 * paying - a late payment turns it into `paid` or `paid_over_capacity`, so the page keeps asking.
 * `paid_over_capacity` is final and is NOT a failure: the money landed, the form was full, and the
 * payer is owed a refund by the organiser.
 *
 * A request the provider reports `declined` (the payer refused) or `cancelled-or-expired` can never
 * be paid: the server released the answer, and the payer may try again (`declined` / `ended`).
 * Only a state READ on this call says so - a bare `cancelled` status names no cause - and never
 * while the row is still `pending`: a pending row waits on a request that is not the dead one
 * (a retry replaced it), and offering a retry there would cancel the request being paid. Anything
 * else that is not paid is final.
 *
 * `pending_cash` is `cash`: the answer waits for the organiser to validate a payment in person
 * (it was answered in cash, or its failed card payment was switched to cash - "Payer en direct").
 * Final for a return page, never a failure: the answer is recorded and keeps its seat.
 */
export function paymentReturnVerdict(
  paymentStatus: string,
  requestState?: PaymentRequestState
): PaymentReturnVerdict {
  if (paymentStatus === 'paid' || paymentStatus === 'free') return 'confirmed';
  if (paymentStatus === 'paid_over_capacity') return 'overCapacity';
  if (paymentStatus === 'pending') return 'wait';
  if (paymentStatus === 'pending_cash') return 'cash';
  if (requestState === 'declined') return 'declined';
  if (requestState === 'cancelled-or-expired') return 'ended';
  if (paymentStatus === 'expired') return 'wait';
  return 'failed';
}

/** True when the payer may answer again because the request their answer waited on is dead. */
export function isRetryableVerdict(verdict: PaymentReturnVerdict): boolean {
  return verdict === 'declined' || verdict === 'ended';
}

/**
 * What the page the payer lands on after LEAVING Lydia shows. `stillOpen` and `unconfirmed` are
 * set by the page itself from the cancel's refusal; this maps a status read from the row.
 */
export type PaymentCancelView = 'cancelled' | 'paid' | 'overCapacity' | 'stillOpen' | 'unconfirmed';

/**
 * The cancel page's reading of a submission's status, before its cancel (a callback may already
 * have confirmed the payment) and after one answered `alreadyPaid` (the request was found paid at
 * Lydia). A paid answer is never shown as cancelled: until 2026-10-15 it was, whatever the row said.
 */
export function paymentCancelView(paymentStatus: string): 'cancelled' | 'paid' | 'overCapacity' {
  const verdict = paymentReturnVerdict(paymentStatus);
  if (verdict === 'confirmed') return 'paid';
  if (verdict === 'overCapacity') return 'overCapacity';
  return 'cancelled';
}

/**
 * The sentence under "payment over capacity" on the member's pages (`/forms/success`,
 * `/forms/cancel`, the form page). A payer on the form's WAITING LIST keeps their place, and their
 * turn makes this paid answer the registration with nothing more charged (`waitlisted`, from the
 * server); anyone else is told to ask the organiser for a refund. A guest never waits: its receipt
 * keeps its own sentence (`form_guest_receipt_over_capacity_desc`).
 */
export function overCapacityDescription(waitlisted: boolean | undefined): string {
  return waitlisted
    ? m.form_success_over_capacity_waitlisted_desc()
    : m.form_success_over_capacity_desc();
}
