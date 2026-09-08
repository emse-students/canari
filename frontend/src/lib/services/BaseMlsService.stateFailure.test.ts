// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';

/**
 * Guards the split between the ways a saved MLS state can refuse to load, and the fact that the
 * split is read off a CODE rather than a sentence.
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
const classify = (error: unknown): 'mismatch' | 'undecryptable' | 'unknown' =>
  (
    BaseMlsService.prototype as unknown as {
      classifyStateLoadFailure(e: unknown): 'mismatch' | 'undecryptable' | 'unknown';
    }
  ).classifyStateLoadFailure(error);

describe('BaseMlsService.classifyStateLoadFailure', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reads the typed identity-mismatch code', () => {
    expect(
      classify(new Error('IDENTITY_MISMATCH: expected u:d-new but state contains u:d-old'))
    ).toBe('mismatch');
  });

  it('reads the typed undecryptable code', () => {
    expect(classify(new Error('STATE_UNDECRYPTABLE: aead::Error'))).toBe('undecryptable');
  });

  it('reads a truncated state as undecryptable too - it is the same outcome', () => {
    // A blob too short to hold a nonce is what an interrupted flush, a full disk or a killed tab
    // leave behind. `mls-core` used to answer `InvalidData` for it and `OpenMls("Decryption: ..")`
    // for a failed tag: two unrelated names for one situation, neither of which the caller could
    // act on.
    expect(classify(new Error('STATE_UNDECRYPTABLE: state blob is 4 bytes, too short'))).toBe(
      'undecryptable'
    );
  });

  it('does NOT read the old prose as a mismatch - the code is the contract', () => {
    // The sentence `mls-core` used to throw. If this ever classifies again, someone has reverted
    // the typed variant and the distinction is back in prose - which is where it silently rots,
    // because a reworded message keeps compiling. There is no version skew to worry about:
    // `frontend/src/lib/wasm/` is generated from `mls-wasm` in this same tree at build time, and
    // `src-tauri` links the same crate, so the thrower and this reader always ship together.
    expect(
      classify(
        new Error('Credential identity mismatch: expected u:d-new but state contains u:d-old')
      )
    ).toBe('unknown');
  });

  it('answers unknown for an unrecognised failure instead of borrowing a diagnosis', () => {
    expect(classify(new Error('boom'))).toBe('unknown');
  });

  it('accuses when it answers unknown, and stays silent when it recognises the failure', () => {
    // EVERY SWALLOWED BRANCH LOGS, and this is the branch that swallowed a whole class of defects.
    // The two known answers must not log, or the line stops being a signal - a message on every
    // ordinary rotation is one its reader learns to skip.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `vi.spyOn` on an already-spied method hands back the SAME spy, calls and all - so without
    // this the count includes whatever the earlier cases in this file logged.
    warn.mockClear();
    classify(new Error('STATE_UNDECRYPTABLE: aead::Error'));
    classify(new Error('IDENTITY_MISMATCH: u:a vs u:b'));
    expect(warn).not.toHaveBeenCalled();
    classify(new Error('boom'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Unrecognised state-load failure');
  });
});
