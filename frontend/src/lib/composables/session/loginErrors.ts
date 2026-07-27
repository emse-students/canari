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
  return error instanceof LoginFailure ? error.code : 'other';
}

/** True when the "PIN changed on another device" recovery flow can resolve this failure. */
export function isRecoverableWithOldPin(code: LoginErrorCode): boolean {
  return code === 'pin_mismatch' || code === 'state_sealed_with_old_key';
}
