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
import { LocalizedError } from '$lib/utils/localizedError';

/** Why a login attempt failed. */
export type LoginErrorCode =
  /** The PIN does not match the account-wide verifier. */
  | 'pin_mismatch'
  /**
   * PIN accepted, and this device's local MLS state would not OPEN.
   *
   * IT NAMES THE OBSERVATION BECAUSE THE OBSERVATION IS ALL THERE IS. It was called
   * `state_sealed_with_old_key`, which asserts a cause the product cannot know: an AEAD tag that
   * does not verify means either "sealed under a different device key" (a PIN rotated elsewhere -
   * the old one recovers it) or "the bytes were altered" (corruption - no PIN is relevant), and
   * nothing stored beside the blob says which. Measured 2026-09-08 on CORRUPT-1 and CORRUPT-2: one
   * flipped byte in an 18.4 MB state produced this code, the user was told their PIN had changed on
   * another device, and the PIN they actually held was then refused five times over.
   *
   * The old-PIN recovery is still offered for it - it costs nothing, it is not destructive, and it
   * is one of the two real possibilities. What changed is that the name, and the message beside it,
   * no longer claim to know which one this is.
   */
  | 'local_state_unopenable'
  /** Biometric mode with nothing in the platform keystore yet. */
  | 'keystore_empty'
  /** This device was revoked; local state has been wiped and it must re-register. */
  | 'device_revoked'
  /** The server could not be REACHED at all - we never got an answer to disagree with. */
  | 'server_unreachable'
  /**
   * The server answered `stale-salt` twice: the account's PIN salt changed (a PIN reset) between
   * this login asking for it and checking with it, and again on the one retry. Nothing was
   * compared, so this says nothing about the PIN typed.
   */
  | 'pin_salt_rotated'
  /**
   * The device key in this device's vault was REFUSED for this account: it came from the unlabelled
   * vault of an older build and did not prove itself on a saved state of this account
   * (`VaultOwnerUnprovenError`). Nothing local was changed. Says nothing about the PIN, and nothing
   * about whether this account has one yet: the gate that follows must ask the server, not assume.
   */
  | 'vault_not_this_account'
  /**
   * The same refusal, on a phone, where it is PROVEN that the one `mls.bin` of this install holds
   * ANOTHER account's state: the vaulted key opened it and its credential named someone else.
   * The gate that follows must not offer the reset, which would delete that account's state.
   */
  | 'device_holds_other_account'
  /** Anything else (network, server, unexpected). */
  | 'other';

/**
 * An `Error` that also states, in machine-readable form, why the login failed.
 *
 * A {@link LocalizedError}, because all six throws build it with a Paraglide message: "that is not
 * your current PIN" is a distinction no status expresses, and the sentence IS the answer. The
 * subclass is what lets the catch that renders it ask, instead of assuming - the same `try` also
 * catches a `TypeError` from a dead socket, whose message is English and must never be shown.
 */
export class LoginFailure extends LocalizedError {
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
  return code === 'pin_mismatch' || code === 'local_state_unopenable';
}

/**
 * True when the failure itself PROVES this device already holds a local MLS state.
 *
 * **WHY A SECOND PREDICATE OVER THE SAME CODE.** `isRecoverableWithOldPin` answers "is there
 * something the old PIN could still do"; this answers "is this device new". They agree today on
 * one code and disagree on the other - a mismatch against the account verifier says nothing about
 * what is on disk - and a caller that reused the first for the second would be reading a column
 * written for another question ([durable-rules](../../../../../docs/wiki/durable-rules.md)).
 *
 * **WHAT IT IS FOR.** `PinModal`'s `isFirstSetup` is computed from a SERVER fact - no
 * `PinVerifier` row for this account - and it hides both remedies the modal can offer: the
 * old-PIN recovery and the reset. `local_state_unopenable` is a LOCAL fact, and the two can be
 * true at once: a `pin-reset` whose server half lands and whose `resetDeviceAsFresh` half does
 * not leaves exactly that pair, and that half can fail on its own. The modal then tells its reader that only a reset restores access, while `isFirstSetup`
 * keeps the reset off the screen. Measured on W2, 2026-09-21.
 */
export function provesLocalStateExists(code: LoginErrorCode): boolean {
  return code === 'local_state_unopenable';
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
 * THE CODES HERE ARE THE ONES WHERE NOTHING IN THIS APPLICATION IS BROKEN and the user is
 * being asked to try something: a PIN that does not match, a local state sealed under an older key
 * (the recovery flow exists for exactly this), an empty keystore on a device that has enrolled
 * nothing yet, and a server nobody could reach - a train tunnel is not a defect. A fifth joined them
 * on 2026-10-14: a vault left by another account, refused as it should be.
 *
 * `device_revoked` is NOT one of them: local state is WIPED on that path, and an erasure deserves a
 * line that accuses whatever anybody later comes looking for. Neither is `other`, which is where the
 * server's 5xx, the WASM that would not load and the genuinely unexpected all land - it is the
 * bucket a real defect arrives in, and this predicate exists to keep it readable.
 */
export function isExpectedLoginOutcome(code: LoginErrorCode): boolean {
  return (
    code === 'pin_mismatch' ||
    code === 'local_state_unopenable' ||
    code === 'keystore_empty' ||
    code === 'server_unreachable' ||
    isVaultRefusal(code)
  );
}

/** True for both refusals of a vaulted key whose owner was not proven (see the two codes). */
export function isVaultRefusal(code: LoginErrorCode | undefined): boolean {
  return code === 'vault_not_this_account' || code === 'device_holds_other_account';
}

/**
 * True when this device's local state is PROVEN to be another account's, so nothing this account
 * does from the gate may delete it - the "forgot PIN" reset above all (`removeMlsState` deletes the
 * one `mls.bin` of the install). Only `device_holds_other_account` proves it.
 */
export function provesOtherAccountState(code: LoginErrorCode | undefined): boolean {
  return code === 'device_holds_other_account';
}
