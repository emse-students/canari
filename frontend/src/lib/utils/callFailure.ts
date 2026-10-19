import { m } from '$lib/paraglide/messages';
import {
  ApiRefusalError,
  describeApiRefusal,
  refusalCode,
  refusalStatus,
} from '$lib/utils/apiRefusal';
import { USER_BLOCKED_CODE } from '$lib/users/blocks';

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
 * It carries the body's `code` when the server sent one: `USER_BLOCKED` (a block stands between the
 * two, WP-C7) is a 403 like any other refusal, and only the code tells it apart.
 *
 * The callee's half throws it too: `GET /api/calls/room-token` is the same setup step seen from the
 * other end, and its 410 ("the ring window closed, the caller has stopped ringing") is a refusal
 * the reader must be told as such, not as a generic failure.
 */
export class CallInitiateError extends ApiRefusalError {
  /**
   * @param step Which setup request refused: the same status means different things at each - a
   *   410 from `room-token` is "the ring window closed", a 410 from `ring` is a room this caller
   *   could not ring. Carried as a type so the reader never parses the message.
   * @param code The refusal's stable code from the response body, or null when it carried none.
   */
  constructor(
    public readonly step: CallSetupStep,
    status: number,
    message: string,
    code: string | null = null
  ) {
    super(status, code, message);
    this.name = 'CallInitiateError';
  }
}

/** The three call-setup requests whose refusal reaches the reader. */
export type CallSetupStep = 'initiate' | 'ring' | 'room-token';

/**
 * The signalling relay answered a `Join` with `Refused { reason }`. An ANSWER, not a transport
 * failure: a resume refused `call-over` (the seat expired, or the other party hung up) ends the
 * call, where a socket that never opened is retried. The reason crosses the throw as a field, so
 * no caller reads it back out of the message.
 */
export class CallSignallingRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`call signalling refused: ${reason}`);
    this.name = 'CallSignallingRefusedError';
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
  // A block, on either side: neutral, as every block refusal is - never who blocked whom.
  if (refusalCode(error) === USER_BLOCKED_CODE) return m.call_unavailable();
  const status = refusalStatus(error);
  if (status === 404) return m.chat_call_group_desynced();
  if (error instanceof CallInitiateError) {
    // 410 from the room-token is the closed ring window: nothing failed, the call ended.
    if (error.step === 'room-token' && status === 410) return m.call_over();
    // The CALLER's ring refused (410 room expired, 403 not its room): its own call could not start.
    // "This call is over" would describe a call the reader never had.
    if (error.step === 'ring' && (status === 410 || status === 403)) return m.call_setup_failed();
  }
  return describeApiRefusal(status, m.chat_call_action_start()) ?? m.chat_call_error_generic();
}
