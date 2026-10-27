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
 *  - anything else -> {@link MlsStateLoadUntypedError}, which the classifier calls `unknown` and
 *    accuses. A message that NAMES a code is still untyped: the text proves nothing.
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
 */
export function mlsStateLoadErrorOf(rejection: unknown): Error {
  if (!isStateLoadRefusal(rejection)) {
    console.error(
      `[MLS] A state load failed outside its { code, message } contract - untyped, so its cause is unknown: ${String(rejection).slice(0, 200)}`
    );
    return new MlsStateLoadUntypedError(String(rejection), rejection);
  }
  const { code, message } = rejection;
  if (code === null) return new MlsStateLoadUntypedError(message, rejection);
  if (isVerdictCode(code)) return new MlsStateVerdictError(code, message, null, rejection);
  if (code === KEYSTORE_KEY_UNAVAILABLE) return new KeystoreKeyUnavailableError(message, rejection);
  console.error(
    `[MLS] A state load failed with the code '${code.slice(0, 60)}', outside the closed set - a bindings mismatch; untyped, nothing will be destroyed on account of it`
  );
  return new MlsStateLoadUntypedError(message, rejection);
}
