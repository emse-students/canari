import { describe, it, expect } from 'vitest';
import { classifyOutgoingSendError } from './mlsSendError';

describe('classifyOutgoingSendError', () => {
  it('reads the EVICTED token emitted by MlsError::Evicted', () => {
    expect(classifyOutgoingSendError(new Error('EVICTED: 4f3a1b2c'))).toBe('evicted');
    // Crossing the Tauri boundary the error arrives as a plain string, not an Error.
    expect(classifyOutgoingSendError('EVICTED: 4f3a1b2c')).toBe('evicted');
  });

  it('does not read the raw OpenMLS wording as an eviction', () => {
    // `UseAfterEviction` is classified in Rust, on the variant, and reaches here as `EVICTED:`.
    // Matching the OpenMLS prose instead would put the decision back on the string, and this test
    // is what keeps that boundary where it belongs: if the Rust arm is ever removed, THIS fails
    // rather than the classifier quietly still working through the underlying wording.
    expect(classifyOutgoingSendError(new Error('Encrypt error: UseAfterEviction'))).toBe('unknown');
  });

  it('leaves every other send failure transient', () => {
    for (const e of [
      'WrongEpoch',
      'Failed to fetch',
      'Encrypt error: LibraryError',
      'UNRECOVERABLE: storage corrupted',
      '',
      null,
      undefined,
    ]) {
      expect(classifyOutgoingSendError(e)).toBe('unknown');
    }
  });
});
