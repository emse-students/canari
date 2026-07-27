// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';

/**
 * Guards the split between the two ways a saved MLS state can refuse to load.
 *
 * `_initImpl` routes on this verdict: `sealed` pauses for the old-PIN recovery, `mismatch` goes
 * straight to a fresh start. Collapsing them told users who had never touched their PIN that it
 * had been changed on another device, and offered them a recovery that could not work.
 */
const classify = (error: unknown): 'mismatch' | 'sealed' =>
  (
    BaseMlsService.prototype as unknown as {
      classifyStateLoadFailure(e: unknown): 'mismatch' | 'sealed';
    }
  ).classifyStateLoadFailure(error);

describe('BaseMlsService.classifyStateLoadFailure', () => {
  it('reads the Rust credential-mismatch error as a mismatch', () => {
    expect(
      classify(
        new Error('Credential identity mismatch: expected u:d-new but state contains u:d-old')
      )
    ).toBe('mismatch');
  });

  it('reads the load_or_create warning wording as a mismatch too', () => {
    expect(classify('load_or_create: identity mismatch - expected=u:d1 loaded=u:d2')).toBe(
      'mismatch'
    );
  });

  it('reads an AEAD failure as a sealed state', () => {
    expect(classify(new Error('Decryption: aead::Error'))).toBe('sealed');
  });

  it('defaults to sealed for an unrecognised failure, keeping recovery available', () => {
    // Erring towards `sealed` costs a recovery prompt; erring towards `mismatch` would discard
    // local history for what may only be a transient or unknown load error.
    expect(classify(new Error('boom'))).toBe('sealed');
  });
});
