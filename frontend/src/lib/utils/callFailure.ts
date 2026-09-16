import { m } from '$lib/paraglide/messages';
import { describeApiRefusal } from '$lib/utils/apiRefusal';

/**
 * A refusal from `POST /api/calls/initiate`, carrying the STATUS instead of spelling it.
 *
 * `CallService.fetchInitiateCall` used to throw `new Error("calls/initiate failed (404): <body>")`,
 * and the only consumer - the toast on the chat page - read that sentence back with
 * `msg.includes('Groupe introuvable') || msg.includes('Group not found')` to decide which of two
 * toasts to show. That is the distinction-in-prose this repository forbids, and it had already
 * rotted: NOTHING in this client throws either of those sentences, so the branch depended on a
 * server body nobody was asserting, and every other refusal - an expired session, a group the
 * caller is no longer in - reached the reader as the raw English line the server happened to write.
 *
 * The status is what the endpoint actually answered, so the status is what crosses the throw.
 *
 * It lives HERE rather than in `CallService.ts` so that the page mapping a failure does not have to
 * import the service to name its error type: calling is held off (`CALLS_ENABLED`) and pulling
 * `CallService` into a module graph that does not otherwise need it would be paid on every cold
 * start.
 */
export class CallInitiateError extends Error {
  constructor(
    /** The HTTP status `POST /api/calls/initiate` answered with. */
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'CallInitiateError';
  }
}

/**
 * THE SENTENCE A FAILED CALL SETUP READS AS, chosen from the status and nothing else.
 *
 * 404 is answered BEFORE `describeApiRefusal`, and that is the one deliberate departure: the
 * generic sentence for a 404 is "l'element n'existe plus", which is true and useless here, while a
 * call whose group the delivery service cannot find means the local conversation and the server's
 * have diverged - and the reader can act on that (`chat_call_group_desynced` tells them how).
 *
 * Everything else goes through the ONE refusal mapper, which answers `null` for a status it has
 * nothing better to say about; the generic line then stands. A transport failure carries no status
 * at all and lands in the same place, which is correct: an unreachable server did not answer, so
 * there is no answer to report.
 *
 * @param error Whatever `startCall` rejected with.
 * @returns A localized sentence, never the thrown message - that belongs in the log.
 */
export function describeCallFailure(error: unknown): string {
  const status = error instanceof CallInitiateError ? error.status : null;
  if (status === 404) return m.chat_call_group_desynced();
  return describeApiRefusal(status, m.chat_call_action_start()) ?? m.chat_call_error_generic();
}
