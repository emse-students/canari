// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { MlsStateVerdictError, type MlsStateVerdictCode } from '$lib/mls-client/mlsStateSeal';
import {
  KeystoreKeyUnavailableError,
  MlsStateLoadUntypedError,
} from '$lib/mls-client/mlsStateLoadError';

/**
 * Guards the split between the ways a saved MLS state can refuse to load, and the fact that the
 * split is read off a TYPE - never a sentence, and since 2026-10-27 not even a code inside one.
 *
 * `_initImpl` routes on this verdict: a `mismatch` decrypted fine and no PIN can repair it, so it
 * goes straight to an identity rotation; anything else is a reason to STOP without destroying
 * what the blob still holds.
 *
 * **THIS FILE USED TO ASSERT THE DEFECT.** Its last case was named *"defaults to sealed for an
 * unrecognised failure, keeping recovery available"* and it was green on
 * `errStr.includes('identity mismatch') ? 'mismatch' : 'sealed'`. That default arm is how one
 * flipped byte in an 18.4 MB state came to tell a user their PIN had been changed on another
 * device (CORRUPT-2, 2026-09-08), and how the PIN they actually held was then refused five times
 * over (CORRUPT-1). A test that pins a default nobody chose pins whatever the default happens to
 * catch.
 */
type Verdict =
  | 'mismatch'
  | 'undecryptable'
  | 'rotated'
  | 'altered'
  | 'keystore_unavailable'
  | 'unknown';

const classify = (error: unknown): Verdict =>
  (
    BaseMlsService.prototype as unknown as {
      classifyStateLoadFailure(e: unknown): Verdict;
    }
  ).classifyStateLoadFailure(error);

describe('BaseMlsService.classifyStateLoadFailure', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /** A verdict typed at its boundary, its message free of any code so only the TYPE can carry it. */
  const verdict = (code: MlsStateVerdictCode): MlsStateVerdictError => {
    const error = new MlsStateVerdictError(code, 'detail');
    error.message = 'no code in this text';
    return error;
  };

  it('reads the typed identity-mismatch verdict', () => {
    expect(classify(verdict('IDENTITY_MISMATCH'))).toBe('mismatch');
  });

  it('reads the typed undecryptable verdict', () => {
    expect(classify(verdict('STATE_UNDECRYPTABLE'))).toBe('undecryptable');
  });

  // EVERY SAVE WRITES A STATE HEADER SINCE STEP 2 (2026-10-17, `mls-core/src/state_blob.rs`), so
  // both halves the fingerprint separates now arrive from the field.
  it('reads the typed key-mismatch verdict as a rotation, which is the half a fingerprint separates', () => {
    expect(classify(verdict('STATE_KEY_MISMATCH'))).toBe('rotated');
  });

  it('reads the typed altered verdict as `altered` - the other half, which no PIN opens', () => {
    // Routed through `undecryptable` it would pause for an old PIN that never existed (CORRUPT-2).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    expect(classify(verdict('STATE_ALTERED'))).toBe('altered');
    expect(warn).not.toHaveBeenCalled();
  });

  // THE POINT OF THE CHANGE OF 2026-10-27. Each of these messages NAMES a code - the way the
  // classifier used to find them - and none is the type. A sentence quoting `STATE_ALTERED` must
  // never buy an irreversible identity rotation.
  it.each([
    'IDENTITY_MISMATCH: expected u:d-new but state contains u:d-old',
    'STATE_UNDECRYPTABLE: aead::Error',
    "STATE_KEY_MISMATCH: the state's header names a different device key",
    'STATE_ALTERED: v1 tag did not verify under the key',
    'KEYSTORE_KEY_UNAVAILABLE: no keystore key and no device_key_b64 provided',
  ])('does NOT classify a message that names a code but is not the type: %s', (text) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    expect(classify(new Error(text))).toBe('unknown');
    expect(classify(new MlsStateLoadUntypedError(text))).toBe('unknown');
    expect(classify(text)).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('reads a v2 decrypt rejection that is not a tag check as `unknown`, accused and not destroyed', () => {
    // The shape `openMlsStateBlobV2` throws for a non-`OperationError` rejection: proving nothing
    // about the bytes, it must never reach the `altered` rotation.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const untyped = new Error(
      'v2 AES-GCM decrypt failed with something other than a tag check, so the state is not proven altered: InvalidAccessError',
      { cause: new DOMException('x', 'InvalidAccessError') }
    );
    expect(classify(untyped)).toBe('unknown');
    expect(warn).toHaveBeenCalled();
  });

  it('does not accuse a rotation of being unrecognised', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    classify(verdict('STATE_KEY_MISMATCH'));
    expect(warn).not.toHaveBeenCalled();
  });

  // A rotation must never take the pre-v0.11.0 Argon2id retry, which keys off `undecryptable`: a
  // v1-framed blob cannot be a legacy one, and trying tells the user to enter a PIN for a migration
  // that does not apply.
  it('keeps a rotation distinct from an undecryptable blob', () => {
    expect(classify(verdict('STATE_KEY_MISMATCH'))).not.toBe('undecryptable');
  });

  it('does NOT read the old prose as a mismatch - the type is the contract', () => {
    // The sentence `mls-core` used to throw. There is no version skew to worry about:
    // `frontend/src/lib/wasm/` is generated from `mls-wasm` in this same tree at build time, and
    // `src-tauri` links the same crate, so the thrower and this reader always ship together.
    expect(
      classify(
        new Error('Credential identity mismatch: expected u:d-new but state contains u:d-old')
      )
    ).toBe('unknown');
  });

  // A refused fingerprint used to print "Unrecognised state-load failure" on every launch that
  // ended on the PIN modal (Mi 9T, 2026-09-28): the keystore answer is typed now, and it is not a
  // verdict on the state.
  it('reads an empty keystore by its type, silently, and never as a state verdict', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const error = new KeystoreKeyUnavailableError('no keystore key');
    error.message = 'no code in this text';
    expect(classify(error)).toBe('keystore_unavailable');
    expect(warn).not.toHaveBeenCalled();
    // The old sentence is no longer a contract - if it classifies again, the type was bypassed.
    expect(classify(new Error('No keystore key and no device_key_b64 provided'))).toBe('unknown');
  });

  it('answers unknown for an unrecognised failure instead of borrowing a diagnosis', () => {
    expect(classify(new Error('boom'))).toBe('unknown');
  });

  it('accuses when it answers unknown, and stays silent when it recognises the failure', () => {
    // EVERY SWALLOWED BRANCH LOGS, and this is the branch that swallowed a whole class of defects.
    // The known answers must not log, or the line stops being a signal - a message on every
    // ordinary rotation is one its reader learns to skip.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `vi.spyOn` on an already-spied method hands back the SAME spy, calls and all - so without
    // this the count includes whatever the earlier cases in this file logged.
    warn.mockClear();
    classify(verdict('STATE_UNDECRYPTABLE'));
    classify(verdict('IDENTITY_MISMATCH'));
    expect(warn).not.toHaveBeenCalled();
    classify(new Error('boom'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Unrecognised state-load failure');
  });
});
