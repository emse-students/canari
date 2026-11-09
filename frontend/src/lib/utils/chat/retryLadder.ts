/**
 * THE ONE RETRY LADDER OF A MESSAGE SEND, shared by the DM/group outbox (`outbox.ts`) and the salon
 * send (`messaging.ts`), so the two paths a member types into wait the same way.
 *
 * A step is the ENTRY'S OWN schedule, never a deadline: nothing is decided when it fires except
 * "ask again", and what ends the wait is an ANSWER - a success, or a refusal. Its cost when wrong is
 * one request answered "not now", bounded by the top step; a reconnect (`connectivity.onReconnect`)
 * skips the step outright, so the ladder is what runs only when no event says the server is back.
 */

/** Delays (ms) between the attempts of one send that keeps meeting no answer or "not now". */
export const BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/** The longest a server's `Retry-After` may hold a send: a header is not a reason to wait for ever. */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * "NOT NOW" answers (502, 503, 504) in a row after which a typed message leaves the waiting state
 * (lead decision, 2026-11-09, review of #3189; the reasoning is in `offline-and-weak-network.md`
 * section 17): a DM or group text for the outbox's failed state ("Echec", with its Retry), a salon
 * text for `unconfirmed` (Retry, Discard, Restore).
 *
 * A "not now" is uncounted only while there is evidence the service is alive, and the evidence is
 * the send's OWN 2xx - which ends the send, so nothing has to reset the count. A websocket reconnect
 * proves the link, never the send route, so it resets nothing. On this ladder twelve answers span
 * about eight minutes (2, 5, 15, 30, 60, 60... s): a rolling deploy ends with a success well before,
 * and a route that stays dead hands the message back to the member. The end is an ANSWER counted,
 * never a clock. Each path keeps the count durable: the outbox row (`unavailableAnswers`) and the
 * salon unsent ledger entry (`salonUnsent.ts`).
 */
export const MAX_UNAVAILABLE_ANSWERS = 12;

/** The ladder's delay after the `attempts`-th failed attempt (post-increment, clamped to the top step). */
export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

/**
 * The hold after the `attempts`-th attempt was answered "not now" (502/503/504,
 * `unavailableAnswer.ts`): the plain ladder step, raised to the server's own `Retry-After` when it
 * sent one (capped at {@link MAX_RETRY_AFTER_MS}). No floor of its own: a deploy lasts seconds, and
 * the first attempt after it must not wait a minute.
 */
export function unavailableHoldMs(attempts: number, retryAfterMs: number | null): number {
  return Math.max(backoffFor(attempts), Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
}
