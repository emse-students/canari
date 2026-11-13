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
 * THE PAYER'S RETURN TO THE APP IS THE TRIGGER, NOT A CLOCK. On a native app Lydia's page opens in
 * the system browser (or the payer confirms in the Lydia app), and the payer comes back to Canari by
 * hand: no return URL is guaranteed to bring them (`webhook.controller.ts`, Lydia is app-driven).
 * So every time the app comes back on screen, the answer is read ONCE through the same confirm read
 * the return page uses - the read that asks Lydia itself, so a lost callback is still caught.
 *
 * One read at a time: an edge that arrives while one is in flight is dropped, since the read in
 * flight already answers it. `subscribe` is the app's one screen-transition source
 * (`onAppScreenChange`), injected for tests. Returns the unsubscribe.
 */
export function readPaymentOnReturnToApp<T extends PaymentAnswer>(opts: {
  read: () => Promise<T>;
  onOutcome: (outcome: PaymentReturnOutcome, answer: T | null) => void;
  subscribe?: (onChange: (onScreen: boolean) => void) => () => void;
}): () => void {
  const subscribe = opts.subscribe ?? onAppScreenChange;
  let inFlight = false;
  let stopped = false;
  Log.d('checkoutReturn', 'watching for the payer return to the app');
  const off = subscribe((onScreen) => {
    if (!onScreen || stopped) return;
    if (inFlight) {
      Log.d('checkoutReturn', 'back on screen while a read is in flight, not asked twice');
      return;
    }
    inFlight = true;
    let last: T | null = null;
    readPaymentReturnOnce(opts.read, (answer) => (last = answer))
      .then((outcome) => {
        if (!stopped) opts.onOutcome(outcome, last);
      })
      .catch((err: unknown) => {
        // Unknown is not a verdict: the view keeps "pending", and the next return asks again.
        console.warn(
          `[checkoutReturn] the read on return failed status=${refusalStatus(err) ?? 'transport'}`,
          err
        );
      })
      .finally(() => {
        inFlight = false;
      });
  });
  return () => {
    stopped = true;
    off();
  };
}
