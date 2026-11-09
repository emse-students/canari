/**
 * Typing a failed MLS state load AT THE BOUNDARY it crosses - never by reading its message.
 *
 * `mls-core` decides the cause on its error VARIANT (`MlsError::state_load_code`) and both
 * boundaries carry it as a field, `{ code, message }` (`StateLoadRefusal` in Rust): the Tauri
 * command `initialiser_mls` rejects with it, and so does `mls-wasm`'s `WasmMlsClient` constructor.
 * {@link mlsStateLoadErrorOf} turns that object into ONE of a closed set of types, read by
 * `classifyStateLoadFailure` (`BaseMlsService`) and `isKeystoreKeyUnavailable` (`IMlsService`)
 * with `instanceof` alone:
 *
 *  - a verdict about the bytes -> {@link MlsStateVerdictError} (`mlsStateSeal.ts`, the same type the
 *    web's v2 opener and the deterministic reader throw);
 *  - an empty keystore -> {@link KeystoreKeyUnavailableError};
 *  - anything else -> {@link MlsStateLoadUntypedError}, accused here and called `unknown` by the
 *    classifier. A message that NAMES a code is still untyped: the text proves nothing.
 *
 * No older shape is understood, deliberately: the native app EMBEDS its frontend and the WASM ships
 * in the same bundle as this file, so the code and its reader always come from one build.
 */
import {
  MLS_STATE_VERDICT_CODES,
  MlsStateVerdictError,
  type MlsStateVerdictCode,
} from './mlsStateSeal';

/** The code an empty keystore carries - `MlsError::KeystoreKeyUnavailable` in `mls-core`. */
const KEYSTORE_KEY_UNAVAILABLE = 'KEYSTORE_KEY_UNAVAILABLE';

/** The code of a sign-in refused over an unfinished move between two accounts' state places. */
const SLOT_MOVE_UNFINISHED = 'SLOT_MOVE_UNFINISHED';

/** The code of a sign-in whose opened state's owner record could not be written. */
const SLOT_OWNER_UNRECORDED = 'SLOT_OWNER_UNRECORDED';

/** The code of a sign-in refused while a "forgot PIN" reset of the account waits for the server. */
const RESET_UNSETTLED = 'RESET_UNSETTLED';

/**
 * A "forgot PIN" reset of this account is staged and not settled (`StateLoadRefusal::reset_unsettled`,
 * round 10 of the review of #2919): its state is set apart, and only the server's answer says whether
 * the PIN was reset. NOT a verdict on any state - nothing was opened or destroyed. The user goes
 * online and retries; the retry settles the reset first.
 */
export class MlsResetUnsettledError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`${RESET_UNSETTLED}: ${detail}`, { cause });
    this.name = 'MlsResetUnsettledError';
  }
}

/**
 * The sign-in opened its state but could not record, beside it, which account it is
 * (`StateLoadRefusal::slot_owner_unrecorded`): the device's storage refused a small write. NOT a
 * verdict on the state - it opened - and nothing was installed or destroyed; the next sign-in writes
 * the record again.
 */
export class MlsSlotOwnerUnrecordedError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`${SLOT_OWNER_UNRECORDED}: ${detail}`, { cause });
    this.name = 'MlsSlotOwnerUnrecordedError';
  }
}

/**
 * The native app keeps one MLS state per account, and a move of one between two accounts' places was
 * cut part-way and could not be finished (`StateLoadRefusal::slot_move_unfinished`, the per-account
 * slot of `mls_account_state.rs`). NOT a verdict on any state - nothing was opened - so nothing is
 * destroyed and no reset is offered: the move is retried at every sign-in, and a restart is the
 * user's way to ask for it again.
 */
export class MlsSlotMoveUnfinishedError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`${SLOT_MOVE_UNFINISHED}: ${detail}`, { cause });
    this.name = 'MlsSlotMoveUnfinishedError';
  }
}

/**
 * Biometric mode found no key in the platform keystore: a cancelled or refused sheet, an entry that
 * was never written or was wiped. NOT a verdict on the saved state - nothing was opened - so the
 * caller destroys nothing and hands the user to the PIN modal.
 */
export class KeystoreKeyUnavailableError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`${KEYSTORE_KEY_UNAVAILABLE}: ${detail}`, { cause });
    this.name = 'KeystoreKeyUnavailableError';
  }
}

/**
 * A state load failed for a reason `mls-core` does not type (a codec error, a poisoned lock, an IPC
 * fault, a trap). Its cause is UNKNOWN, and is classified so explicitly - never guessed from its
 * text, which is kept for the logs only.
 */
export class MlsStateLoadUntypedError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(detail, { cause });
    this.name = 'MlsStateLoadUntypedError';
  }
}

/** The `{ code, message }` shape both boundaries reject with, checked field by field. */
function isStateLoadRefusal(value: unknown): value is { code: string | null; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return (code === null || typeof code === 'string') && typeof message === 'string';
}

function isVerdictCode(code: string): code is MlsStateVerdictCode {
  return MLS_STATE_VERDICT_CODES.has(code);
}

/**
 * The typed error a rejection from a state-loading boundary (`initialiser_mls`, the WASM
 * constructor) amounts to, read from its `code` FIELD alone.
 *
 * A rejection that is not the `{ code, message }` shape at all - the IPC bridge refusing the call
 * before the command ran, a WASM trap - is untyped and ACCUSED here, because it means the
 * boundary's contract was not what answered. So is a code outside the closed set: these bindings and
 * `mls-core` disagree, a build defect, never a verdict.
 *
 * **EVERY UNTYPED ANSWER IS LOGGED HERE, ONCE, AND NOWHERE ELSE.** Not every caller classifies (the
 * MLS workers and the WebMlsService key probes construct a client too), so the boundary is the one
 * place every such failure passes; `classifyStateLoadFailure` stays silent on an
 * {@link MlsStateLoadUntypedError} for that reason, and two lines for one failure would be noise.
 */
export function mlsStateLoadErrorOf(rejection: unknown): Error {
  if (!isStateLoadRefusal(rejection)) {
    console.error(
      `[MLS] A state load failed outside its { code, message } contract - untyped, so its cause is unknown: ${String(rejection).slice(0, 200)}`
    );
    return new MlsStateLoadUntypedError(String(rejection), rejection);
  }
  const { code, message } = rejection;
  if (code === null) {
    console.warn(
      `[MLS] A state load failed for a reason mls-core does not type, so its cause is unknown and nothing will be destroyed on account of it: ${message.slice(0, 200)}`
    );
    return new MlsStateLoadUntypedError(message, rejection);
  }
  if (isVerdictCode(code)) return new MlsStateVerdictError(code, message, null, rejection);
  if (code === KEYSTORE_KEY_UNAVAILABLE) return new KeystoreKeyUnavailableError(message, rejection);
  if (code === SLOT_MOVE_UNFINISHED) {
    console.error(
      `[MLS] The sign-in was refused: a move of a local state between two accounts is unfinished - nothing destroyed, retried at the next sign-in: ${message.slice(0, 200)}`
    );
    return new MlsSlotMoveUnfinishedError(message, rejection);
  }
  if (code === RESET_UNSETTLED) {
    console.warn(
      `[MLS] The sign-in was refused: a PIN reset of this account waits for the server's answer - nothing destroyed, settled at the next attempt online: ${message.slice(0, 200)}`
    );
    return new MlsResetUnsettledError(message, rejection);
  }
  if (code === SLOT_OWNER_UNRECORDED) {
    console.error(
      `[MLS] The sign-in opened its state but could not record its owner - nothing installed, nothing destroyed: ${message.slice(0, 200)}`
    );
    return new MlsSlotOwnerUnrecordedError(message, rejection);
  }
  console.error(
    `[MLS] A state load failed with the code '${code.slice(0, 60)}', outside the closed set - a bindings mismatch; untyped, nothing will be destroyed on account of it`
  );
  return new MlsStateLoadUntypedError(message, rejection);
}
