/** What a form submission's payment status means for the page the payer lands on after Lydia. */
export type PaymentReturnVerdict =
  | 'confirmed'
  | 'wait'
  | 'overCapacity'
  | 'declined'
  | 'ended'
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
 * Only a state READ on this call says so - a bare `cancelled` status names no cause. Anything else
 * that is not paid is final.
 */
export function paymentReturnVerdict(
  paymentStatus: string,
  requestState?: PaymentRequestState
): PaymentReturnVerdict {
  if (paymentStatus === 'paid' || paymentStatus === 'free') return 'confirmed';
  if (paymentStatus === 'paid_over_capacity') return 'overCapacity';
  if (requestState === 'declined') return 'declined';
  if (requestState === 'cancelled-or-expired') return 'ended';
  if (paymentStatus === 'pending' || paymentStatus === 'expired') return 'wait';
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
