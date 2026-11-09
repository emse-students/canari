/**
 * THE ONE ANSWER TO "DID THE SERVER SAY 'NOT NOW'?", read from the status a refusal carries.
 *
 * A STATUS CODE IS AN ANSWER, and three of them say the same thing: the service is not serving right
 * now, try again. `502 Bad Gateway` and `504 Gateway Timeout` are written by a proxy about the service
 * behind it (the estate's nginx answers both in JSON while a container rotates, see
 * `infrastructure/local/Dockerfile.frontend`, `@api_error_502`/`@api_error_504`), and `503 Service
 * Unavailable` by a proxy with no upstream left (`no live upstreams`) or by a service that could not
 * ask a peer it depends on (chat-delivery's `entitlement_unavailable` while social-service restarts).
 * A production deploy answers exactly these for its few seconds, and none of them is a REFUSAL of the
 * message: no retry is wrong because of what the message is, and the one that comes after the deploy
 * succeeds.
 *
 * Every other 5xx (`500`, `501`, `505`...) is the service answering that IT failed on this request:
 * that one keeps its own policy (`MAX_CONSECUTIVE_SERVER_ERRORS` in `outbox.ts`).
 *
 * WHAT IT DOES NOT SAY: whether the request was stored. A `502` after the upstream reset mid-answer,
 * or a `504`, may come after the service wrote the row - so a repeat must be idempotent by the
 * message's client id, which both send paths are (the delivery receivers deduplicate on `messageId`,
 * social-service answers a salon repeat with the row it holds, migration 090).
 *
 * Read through {@link isUnavailableAnswer} by every consumer, never by a status test of its own.
 */
// The class alone, never `apiRefusal.ts`: that one pulls the whole Paraglide catalogue, and this
// predicate is read by the data layer (`mlsDeliveryApi.ts`).
import { ApiRefusalError } from './apiRefusalError';

/** The statuses that answer "not now": see the module docblock. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** True when `status` is one of the "not now" answers (502, 503, 504). */
export function isUnavailableStatus(status: number | null | undefined): boolean {
  return status !== null && status !== undefined && UNAVAILABLE_STATUSES.has(status);
}

/**
 * True when `error` is a refusal whose status says the service is not serving right now (502, 503,
 * 504), read from the TYPE the throw carried (`ApiRefusalError.status`), never from its sentence.
 * A transport failure (no status) is not one: nobody answered.
 */
export function isUnavailableAnswer(error: unknown): boolean {
  return error instanceof ApiRefusalError && isUnavailableStatus(error.status);
}
