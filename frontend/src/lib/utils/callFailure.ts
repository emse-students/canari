import { m } from '$lib/paraglide/messages';
import { ApiRefusalError, describeApiRefusal, refusalStatus } from '$lib/utils/apiRefusal';

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
 *
 * It carries no `code`: the initiate route answers a status and a body, and inventing a code slot
 * it never fills would be a discriminator nothing sets.
 *
 * The callee's half throws it too: `GET /api/calls/room-token` is the same setup step seen from the
 * other end, and its 410 ("the ring window closed, the caller has stopped ringing") is a refusal
 * the reader must be told as such, not as a generic failure.
 */
export class CallInitiateError extends ApiRefusalError {
  constructor(status: number, message: string) {
    super(status, null, message);
    this.name = 'CallInitiateError';
  }
}

/**
 * This engine cannot encrypt call media end to end, so the call is REFUSED before any request.
 *
 * A call's media is encrypted with an MLS-derived key through `RTCRtpScriptTransform`. An engine
 * without it used to degrade to a call the other party's transform could not decrypt (it sent
 * cleartext and still tried to decrypt what it received), behind a warning badge. Refusing is the
 * rule for a fallback here: the user is told, and nothing is sent in the clear.
 */
export class CallE2eUnsupportedError extends Error {
  constructor() {
    super('RTCRtpScriptTransform is unavailable - end-to-end call encryption is impossible here');
    this.name = 'CallE2eUnsupportedError';
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
  if (error instanceof CallE2eUnsupportedError) return m.call_e2e_unsupported();
  const status = refusalStatus(error);
  if (status === 404) return m.chat_call_group_desynced();
  // 410 is the room-token's answer once the ring window has closed: nothing failed, the call ended.
  if (status === 410) return m.call_over();
  return describeApiRefusal(status, m.chat_call_action_start()) ?? m.chat_call_error_generic();
}
