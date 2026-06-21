import { describe, it, expect } from 'vitest';
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
