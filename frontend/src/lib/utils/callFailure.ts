import { m } from '$lib/paraglide/messages';
import type { E2eBypass } from './callE2eReport';
import {
  ApiRefusalError,
  describeApiRefusal,
  refusalCode,
  refusalStatus,
} from '$lib/utils/apiRefusal';
import { USER_BLOCKED_CODE } from '$lib/users/blocks';
import { REVIEW_COHORT_BOUNDARY_CODE, describeRefusalCode } from '$lib/utils/refusalCodes';

/** The server's kill switch refused (`platform_config.calls_mode`): every call, or video only. */
const CALLS_CLOSED_CODES: readonly string[] = ['CALLS_DISABLED', 'CALLS_VIDEO_DISABLED'];

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

/** The call-setup requests whose refusal reaches the reader. */
export type CallSetupStep = 'initiate' | 'ring' | 'room-token' | 'ice-servers';

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
 * The call a setup step was working for ENDED while the step awaited (a hangup during the
 * microphone prompt, a declined or cancelled ring): nothing failed, and the step's result belongs to
 * nobody. Thrown by `CallService.assertSetupLive` after every await of `startCall`/`acceptCall`,
 * so a late step never keys a worker, holds a microphone or joins a room for a call that is over -
 * and caught there without a toast or a second hangup, the call having already ended.
 */
export class CallSetupAbandonedError extends Error {
  constructor(public readonly step: string) {
    super(`the call ended during its setup (${step})`);
    this.name = 'CallSetupAbandonedError';
  }
}

/**
 * Media crossed the network AROUND this device's E2E transform: RTP packets were sent (or received)
 * while the worker was never handed one frame on that side, so the engine sent clear media (or fed
 * the other party's ciphertext to the decoder). Proven from two counters (`e2eBypassedSides`), never
 * inferred, and the call ENDS: carrying it on would be the transport-only call the app refuses.
 *
 * WHY (CALL-E2E-BYPASS-MI9T, 2026-10-20): Chromium short-circuits a transform assigned one task after
 * its sender or transceiver was created, for good, and every Chromium client of `1.3.1-alpha.*` did
 * exactly that while its screen said "end-to-end encrypted".
 */
export class CallE2eBypassedError extends Error {
  constructor(public readonly sides: readonly E2eBypass[]) {
    super(`media flowed around the E2E transform (${sides.join(' and ')})`);
    this.name = 'CallE2eBypassedError';
  }
}

/**
 * A transform could not be ATTACHED (the worker holds no call key, or the engine refused the
 * assignment), so the call ENDS rather than carry that track unencrypted. Distinct from
 * {@link CallE2eBypassedError}, which is a transform attached and then bypassed.
 */
export class CallE2eSetupError extends Error {
  constructor(
    public readonly what: string,
    options?: { cause?: unknown }
  ) {
    super(`E2E transform could not be attached: ${what}`, options);
    this.name = 'CallE2eSetupError';
  }
}

/**
 * The call never connected AND the server had withheld its TURN relay (`ice-servers` answered
 * `turn: { status: 'unavailable', code }`: the month's relay budget is spent, or its meter cannot
 * be read). The two facts together are the explanation: a direct path was the only one left, and
 * there was none. `code` is the server's (`TURN_BUDGET_REACHED`, `TURN_METER_UNAVAILABLE`), kept
 * for the log; the reader gets one sentence for both, since neither is theirs to fix.
 */
/** The server's code for TURN off BY CONFIGURATION (a budget of 0): permanent, not a passing outage. */
export const TURN_DISABLED_CODE = 'TURN_DISABLED';

export class CallRelayWithheldError extends Error {
  constructor(public readonly code: string) {
    super(`no direct path, and the server withheld the TURN relay (${code})`);
    this.name = 'CallRelayWithheldError';
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
  if (error instanceof CallE2eBypassedError) return m.call_e2e_bypassed();
  if (error instanceof CallE2eSetupError) return m.call_e2e_setup_failed();
  if (error instanceof CallRelayWithheldError) {
    // Off by configuration is not "unavailable right now": it will be the same on the next try.
    return error.code === TURN_DISABLED_CODE ? m.call_relay_disabled() : m.call_relay_withheld();
  }
  // A block, on either side, or the review cohort's boundary: neutral, as every block refusal is -
  // never who blocked whom, never that the other account is a review account.
  const refused = refusalCode(error);
  if (refused === USER_BLOCKED_CODE || refused === REVIEW_COHORT_BOUNDARY_CODE) {
    return m.call_unavailable();
  }
  // The kill switch, at whichever step it answered: said as such, never as a failure to retry.
  const code = refusalCode(error);
  if (code && CALLS_CLOSED_CODES.includes(code)) {
    return describeRefusalCode(code) ?? m.call_calls_disabled();
  }
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
