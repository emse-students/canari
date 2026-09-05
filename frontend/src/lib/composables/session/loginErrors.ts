/**
 * Machine-readable login failure codes.
 *
 * The UI has to branch on WHY a login failed -- notably to offer the "PIN changed on another
 * device" recovery -- while the text shown to the user is localized through Paraglide. Those
 * two needs conflict if the branch is a regex over the message: translating a string, or
 * rewording it, silently disables the branch (a never-matching regex ships unnoticed).
 *
 * So the code travels beside the message: {@link LoginFailure} carries both, and
 * `ChatSessionCallbacks.onLoginFailed` receives both.
 */

import { isServerUnreachable } from '$lib/utils/fetchOrUnreachable';

/** Why a login attempt failed. */
export type LoginErrorCode =
  /** The PIN does not match the account-wide verifier. */
  | 'pin_mismatch'
  /** PIN accepted, but this device's local MLS state is sealed under an older key. */
  | 'state_sealed_with_old_key'
  /** Biometric mode with nothing in the platform keystore yet. */
  | 'keystore_empty'
  /** This device was revoked; local state has been wiped and it must re-register. */
  | 'device_revoked'
  /** The server could not be REACHED at all - we never got an answer to disagree with. */
  | 'server_unreachable'
  /** Anything else (network, server, unexpected). */
  | 'other';

/** An `Error` that also states, in machine-readable form, why the login failed. */
export class LoginFailure extends Error {
  readonly code: LoginErrorCode;

  constructor(code: LoginErrorCode, message: string) {
    super(message);
    this.name = 'LoginFailure';
    this.code = code;
  }
}

/**
 * Reads the failure code off an unknown thrown value, defaulting to `'other'`.
 * Use this instead of matching on `error.message`.
 */
export function loginErrorCode(error: unknown): LoginErrorCode {
  if (error instanceof LoginFailure) return error.code;
  // A TRANSPORT FAILURE ARRIVES AS ITS OWN TYPE FROM A LOWER LAYER, and is mapped here rather than
  // thrown as a `LoginFailure` there: `fetchOrUnreachable` is a generic utility and has no business
  // knowing this module's vocabulary. The mapping is the seam between the two.
  if (isServerUnreachable(error)) return 'server_unreachable';
  return 'other';
}

/** True when the "PIN changed on another device" recovery flow can resolve this failure. */
export function isRecoverableWithOldPin(code: LoginErrorCode): boolean {
  return code === 'pin_mismatch' || code === 'state_sealed_with_old_key';
}

/**
 * True when a login that did not go through is an ORDINARY OUTCOME rather than a defect HERE.
 *
 * **ONLY ONE KIND OF FAILURE ACCUSES THIS APPLICATION, AND THE LOG LEVEL IS HOW IT SAYS SO.** Every
 * login failure lands in one catch in `sessionAuth.ts`, which logged all of them with
 * `console.error('[INIT] Login failed: ...')` - so a person mistyping their PIN, the single most
 * ordinary outcome this screen has, produced the same line as a WASM build that would not load.
 * Measured by `pinrows.mjs --row 2` on 2026-09-05: five deliberate wrong PINs, five console errors,
 * on a product doing exactly what it should. `--row 8` then did the same with the network cut.
 *
 * The discriminator already existed one line below the log - `loginErrorCode(_e)` is read to decide
 * what the UI offers - which is what makes this a classification that was available and unused
 * rather than one that had to be invented.
 *
 * THE FOUR CODES HERE ARE THE ONES WHERE NOTHING IN THIS APPLICATION IS BROKEN and the user is
 * being asked to try something: a PIN that does not match, a local state sealed under an older key
 * (the recovery flow exists for exactly this), an empty keystore on a device that has enrolled
 * nothing yet, and a server nobody could reach - a train tunnel is not a defect.
 *
 * `device_revoked` is NOT one of them: local state is WIPED on that path, and an erasure deserves a
 * line that accuses whatever anybody later comes looking for. Neither is `other`, which is where the
 * server's 5xx, the WASM that would not load and the genuinely unexpected all land - it is the
 * bucket a real defect arrives in, and this predicate exists to keep it readable.
 */
export function isExpectedLoginOutcome(code: LoginErrorCode): boolean {
  return (
    code === 'pin_mismatch' ||
    code === 'state_sealed_with_old_key' ||
    code === 'keystore_empty' ||
    code === 'server_unreachable'
  );
}
