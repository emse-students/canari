import { Log } from '$lib/utils/Log';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { onAppScreenChange } from '$lib/utils/appForeground';
import { paymentReturnVerdict, type PaymentRequestState } from './paymentReturn';
import { returnOutcomeOf, type PaymentReturnOutcome } from './paymentReturnPoll';

/** An answer's payment as the confirm read returns it (`confirmSubmissionPayment`). */
type PaymentAnswer = { paymentStatus: string; requestState?: PaymentRequestState };

/**
 * True when the confirm read was refused by the server's per-answer limit on asking Lydia (429):
 * an ANSWER, not a failure - the callback still decides, so the view stays "pending". Read from the
 * refusal's status, never from its message.
 */
export function isConfirmThrottled(err: unknown): boolean {
  return refusalStatus(err) === 429;
}

/**
 * True when the confirm read was refused because THIS browser holds no session that may read the
 * answer (401, or 403 for another account): the payer paid from a browser the app handed them to.
 * Nothing is known about the payment from here, so the page must not say it was not found.
 */
export function isConfirmUnreadableHere(err: unknown): boolean {
  const status = refusalStatus(err);
  return status === 401 || status === 403;
}

/**
 * ONE read of an answer's payment, worded as the return pages word it (`returnOutcomeOf`): a state
 * that can still change, and a throttled read, are `pending`. Any other failure is thrown: the
 * caller says it, and a failed read decides nothing.
 */
export async function readPaymentReturnOnce<T extends PaymentAnswer>(
  read: () => Promise<T>,
  onRead: (answer: T) => void = () => {}
): Promise<PaymentReturnOutcome> {
  Log.d('checkoutReturn', 'reading the answer payment once');
  try {
    const answer = await read();
    onRead(answer);
    const outcome =
      returnOutcomeOf(paymentReturnVerdict(answer.paymentStatus, answer.requestState)) ?? 'pending';
    Log.d('checkoutReturn', `read ${answer.paymentStatus} -> ${outcome}`);
    return outcome;
  } catch (err) {
    if (isConfirmThrottled(err)) {
      Log.d('checkoutReturn', 'confirm read throttled, left pending');
      return 'pending';
    }
    throw err;
  }
}

/**
 * The reads of ONE pending checkout. A page makes one per checkout it watches, and its IDENTITY is
 * the checkout's generation: an outcome read by a reader the page no longer holds is about a
 * checkout that ended (released, then paid again under the same answer id) and is dropped by the
 * page, whatever order the network answered in.
 */
export interface PaymentReader {
  /**
   * One read through {@link readPaymentReturnOnce}, or `null` without asking when a read of this
   * checkout is already in flight - the one in flight answers this question too, so the load, the
   * return to the app and a tap never ask Lydia twice at once.
   */
  readOnce(): Promise<PaymentReturnOutcome | null>;
}

/** A {@link PaymentReader} over `read`, the page's confirm call for one answer. */
export function createPaymentReader<T extends PaymentAnswer>(
  read: () => Promise<T>
): PaymentReader {
  let inFlight = false;
  return {
    async readOnce() {
      if (inFlight) {
        Log.d('checkoutReturn', 'a read of this checkout is in flight, not asked twice');
        return null;
      }
      inFlight = true;
      try {
        return await readPaymentReturnOnce(read);
      } finally {
        inFlight = false;
      }
    },
  };
}

/**
 * THE PAYER'S RETURN TO THE APP IS THE TRIGGER, NOT A CLOCK. On a native phone Lydia's page opens
 * in the system browser (or the payer confirms in the Lydia app), and the payer comes back to Canari
 * by hand: no return URL is guaranteed to bring them (`webhook.controller.ts`, Lydia is app-driven).
 * So `onReturn` runs each time the app comes back on screen; the caller reads ONCE from it.
 *
 * `subscribe` is the app's one screen-transition source (`onAppScreenChange`: `canari:foreground`
 * on the phones, `visibilitychange` elsewhere), injected for tests. Returns the unsubscribe.
 */
export function watchReturnsToApp(
  onReturn: () => void,
  subscribe: (onChange: (onScreen: boolean) => void) => () => void = onAppScreenChange
): () => void {
  Log.d('checkoutReturn', 'watching for the payer return to the app');
  return subscribe((onScreen) => {
    if (!onScreen) return;
    Log.d('checkoutReturn', 'back on screen with a checkout pending');
    onReturn();
  });
}

/**
 * The answer a login page's `returnTo` is the payment return of, or null. A payer the Android
 * https return left in the phone's browser, with no Canari session there, is sent to `/login` by
 * the boot with `/forms/success?submission_id=...` behind it: that page says where the payment
 * went instead of only asking for a sign-in.
 */
export function paymentReturnSubmissionId(returnTo: string): string | null {
  if (!returnTo.startsWith('/forms/success')) return null;
  try {
    const url = new URL(returnTo, 'https://canari.invalid');
    if (url.pathname.replace(/\/$/, '') !== '/forms/success') return null;
    return url.searchParams.get('submission_id') || null;
  } catch {
    return null;
  }
}
