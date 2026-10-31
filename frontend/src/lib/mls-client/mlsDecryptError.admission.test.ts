/**
 * `ADMISSION_REFUSED` is a PROOF, not a desync: `mls-core` refused a commit that brings a new user
 * in on their own (see `frontend/mls-core/tests/admission_policy.rs`). It must never be read as any
 * of the recoverable kinds, because every one of them leads to a recovery - and the recovery that
 * follows a refused commit is an external join on the server's GroupInfo, which contains the
 * intruder.
 */
import { classifyIncomingDecryptError } from './mlsDecryptError';

describe('classifyIncomingDecryptError - admission refusals', () => {
  it('names a refused admission', () => {
    expect(
      classifyIncomingDecryptError(
        new Error('ADMISSION_REFUSED: mallory:dev7 entered by external commit')
      )
    ).toBe('admission-refused');
  });

  it('wins over the native gap wrapper, which would send it to a commit replay', () => {
    expect(
      classifyIncomingDecryptError(
        'GAP_QUEUED:642f389a:ADMISSION_REFUSED: mallory:dev7 entered by external commit'
      )
    ).toBe('admission-refused');
  });

  it('wins over same-epoch refusal, which the pipeline answers with a re-add', () => {
    expect(
      classifyIncomingDecryptError(
        'Crypto/OpenMLS error: Process error: same-epoch refusal ADMISSION_REFUSED: mallory:dev7 [msg_epoch=3, group_epoch=3]'
      )
    ).toBe('admission-refused');
  });

  it('wins over WrongEpoch', () => {
    expect(classifyIncomingDecryptError('WrongEpoch ADMISSION_REFUSED: mallory:dev7')).toBe(
      'admission-refused'
    );
  });
});
