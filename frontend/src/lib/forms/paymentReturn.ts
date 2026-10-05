/** What a form submission's payment status means for the page the payer lands on after Lydia. */
export type PaymentReturnVerdict = 'confirmed' | 'wait' | 'failed';

/**
 * `pending` is the only status that can still change: the signed Lydia callback may arrive after
 * the browser redirect, so the page keeps asking. Anything else that is not paid is final.
 */
export function paymentReturnVerdict(paymentStatus: string): PaymentReturnVerdict {
  if (paymentStatus === 'paid' || paymentStatus === 'free') return 'confirmed';
  if (paymentStatus === 'pending') return 'wait';
  return 'failed';
}
