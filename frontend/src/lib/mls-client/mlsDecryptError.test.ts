import { classifyIncomingDecryptError } from './mlsDecryptError';

describe('classifyIncomingDecryptError', () => {
  it('reconnait CannotDecryptOwnMessage', () => {
    expect(classifyIncomingDecryptError('Process error: CannotDecryptOwnMessage')).toBe(
      'own-message'
    );
  });

  it('reconnait SecretReuseError', () => {
    expect(
      classifyIncomingDecryptError(new Error('ValidationError(UnableToDecrypt(SecretReuseError))'))
    ).toBe('secret-reuse');
  });

  it('reconnait le gap (GAP_QUEUED et "epoch gap")', () => {
    expect(classifyIncomingDecryptError('GAP_QUEUED')).toBe('epoch-gap');
    expect(classifyIncomingDecryptError('epoch gap [msg_epoch=2, group_epoch=1]')).toBe(
      'epoch-gap'
    );
  });

  it('reconnait une generation trop en avance, meme enveloppee dans GAP_QUEUED', () => {
    // The native layer wraps the OpenMLS error, so both markers are present at once - and reading
    // this one as an epoch gap sends it to a commit replay that cannot help (WP-PENDING-2).
    expect(
      classifyIncomingDecryptError(
        'GAP_QUEUED:642f389a:Crypto/OpenMLS error: Process error: ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInTheFuture))) [msg_epoch=1, group_epoch=1]'
      )
    ).toBe('generation-gap');
    expect(classifyIncomingDecryptError(new Error('SecretTreeError(TooDistantInTheFuture)'))).toBe(
      'generation-gap'
    );
  });

  it('reconnait une frame applicative d une epoque deja depassee', () => {
    expect(
      classifyIncomingDecryptError(
        'Crypto/OpenMLS error: Process error: past epoch application frame [msg_epoch=1, group_epoch=4]'
      )
    ).toBe('past-epoch-application');
    // Wrapped by the native layer, like every other error it forwards. It must NOT read as an
    // epoch gap: a commit replay repairs an epoch we are BEHIND and can do nothing for one we are
    // already past, and the frame would be ACKed off the server as healed (WP-PENDING-2's shape).
    expect(
      classifyIncomingDecryptError(
        'GAP_QUEUED:642f389a:Crypto/OpenMLS error: Process error: past epoch application frame [msg_epoch=1, group_epoch=4]'
      )
    ).toBe('past-epoch-application');
  });

  it('reconnait WrongEpoch', () => {
    expect(classifyIncomingDecryptError('Process error: WrongEpoch')).toBe('wrong-epoch');
  });

  it('reconnait les paniques WASM (oom)', () => {
    expect(classifyIncomingDecryptError('RuntimeError: out of memory')).toBe('oom');
    expect(classifyIncomingDecryptError('unreachable executed')).toBe('oom');
  });

  it('retombe sur unknown pour le reste', () => {
    expect(classifyIncomingDecryptError('NoMatchingKeyPackage')).toBe('unknown');
    expect(classifyIncomingDecryptError('quoi que ce soit')).toBe('unknown');
    expect(classifyIncomingDecryptError(undefined)).toBe('unknown');
  });

  it('priorise own-message sur secret-reuse quand les deux marqueurs coexistent', () => {
    // Cas theorique (marqueurs en pratique mutuellement exclusifs) : l'ordre doit etre deterministe.
    expect(classifyIncomingDecryptError('CannotDecryptOwnMessage + SecretReuseError')).toBe(
      'own-message'
    );
  });
});
