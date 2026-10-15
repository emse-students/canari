/** What a form submission's payment status means for the page the payer lands on after Lydia. */
export type PaymentReturnVerdict = 'confirmed' | 'wait' | 'overCapacity' | 'failed';

/**
 * `pending` and `expired` can still change: the signed Lydia callback may arrive after the browser
 * redirect, and an online `expired` row is one whose seat was released while the payer was still
 * paying - a late payment turns it into `paid` or `paid_over_capacity`, so the page keeps asking.
 * `paid_over_capacity` is final and is NOT a failure: the money landed, the form was full, and the
 * payer is owed a refund by the organiser. Anything else that is not paid is final.
 */
export function paymentReturnVerdict(paymentStatus: string): PaymentReturnVerdict {
  if (paymentStatus === 'paid' || paymentStatus === 'free') return 'confirmed';
  if (paymentStatus === 'pending' || paymentStatus === 'expired') return 'wait';
  if (paymentStatus === 'paid_over_capacity') return 'overCapacity';
  return 'failed';
}
