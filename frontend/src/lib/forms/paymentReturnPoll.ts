import { paymentReturnVerdict, type PaymentRequestState } from './paymentReturn';

/** What a payment return page ends on, once it stops asking. */
export type PaymentReturnOutcome =
  | 'confirmed'
  | 'pending'
  | 'overCapacity'
  | 'declined'
  | 'ended'
  | 'error';

/** Ceiling on how long a return page keeps asking before it says the payment is unconfirmed. */
export const RETURN_MAX_POLLS = 10;
export const RETURN_POLL_INTERVAL_MS = 3000;

/**
 * THE ONE POLL BOTH PAYMENT RETURN PAGES RUN - the member's (`/forms/success`, by submission, with a
 * session) and the guest's (`/f/:id/receipt`, by receipt, without one). Each read asks the server
 * to check the answer's own request at Lydia, so a payment whose callback was lost is still
 * confirmed while the payer is looking; the page decides nothing from its URL.
 *
 * `read` is the page's confirmation call; `onRead` sees every answer (the page keeps what it shows
 * from it - a form id, a reference). A thrown read is the caller's to word: the poll does not catch.
 */
export async function pollPaymentReturn<
  T extends { paymentStatus: string; requestState?: PaymentRequestState },
>(
  read: () => Promise<T>,
  onRead: (answer: T) => void = () => {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<PaymentReturnOutcome> {
  for (let attempt = 0; attempt < RETURN_MAX_POLLS; attempt++) {
    const answer = await read();
    onRead(answer);
    const verdict = paymentReturnVerdict(answer.paymentStatus, answer.requestState);
    if (verdict === 'confirmed' || verdict === 'overCapacity') return verdict;
    if (verdict === 'declined' || verdict === 'ended') {
      // The request is dead and the server released the answer: the payer may try again.
      console.info(`[paymentReturn] request ${verdict}, the answer is released for a retry`);
      return verdict;
    }
    if (verdict === 'failed') return 'error';
    await sleep(RETURN_POLL_INTERVAL_MS);
  }
  return 'pending';
}
