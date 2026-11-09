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
