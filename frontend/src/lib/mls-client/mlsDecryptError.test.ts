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
        'GAP_QUEUED:642f389a:Crypto/OpenMLS error: Process error: same-epoch refusal ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInTheFuture))) [msg_epoch=1, group_epoch=1]'
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

  it('reconnait un refus a sa propre epoque', () => {
    expect(
      classifyIncomingDecryptError(
        'Crypto/OpenMLS error: Process error: same-epoch refusal ValidationError(InvalidSignature) [msg_epoch=0, group_epoch=0]'
      )
    ).toBe('same-epoch-refusal');
  });

  it('ne lit pas un refus a sa propre epoque comme un gap, meme enveloppe par le natif', () => {
    // `SenderRatchetGap` is the native catch-all, so it wraps this refusal in `GAP_QUEUED` and
    // writes a retry row for it. Read as an epoch gap on the web, it goes through a commit replay
    // that applies nothing and reports success - WP-PENDING-2's exact shape, one kind later.
    expect(
      classifyIncomingDecryptError(
        'GAP_QUEUED:642f389a:Crypto/OpenMLS error: Process error: same-epoch refusal ValidationError(InvalidSignature) [msg_epoch=0, group_epoch=0]'
      )
    ).toBe('same-epoch-refusal');
  });

  it('laisse les marqueurs de cliquet gagner sur le refus generique qui les transporte', () => {
    // `mls-core` emits all three from the SAME return, embedding the OpenMLS error inside its own
    // marker - so these strings carry two, and the specific one names the ratchet position while
    // the general one says only that the epochs matched. Reading them the other way round would
    // collapse a re-Welcome and a history solicitation into one policy.
    expect(
      classifyIncomingDecryptError(
        'Process error: same-epoch refusal ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInTheFuture))) [msg_epoch=3, group_epoch=3]'
      )
    ).toBe('generation-gap');
    expect(
      classifyIncomingDecryptError(
        'Process error: same-epoch refusal ValidationError(UnableToDecrypt(SecretReuseError)) [msg_epoch=3, group_epoch=3]'
      )
    ).toBe('secret-reuse');
  });

  it('priorise own-message sur secret-reuse quand les deux marqueurs coexistent', () => {
    // Cas theorique (marqueurs en pratique mutuellement exclusifs) : l'ordre doit etre deterministe.
    expect(classifyIncomingDecryptError('CannotDecryptOwnMessage + SecretReuseError')).toBe(
      'own-message'
    );
  });
});

describe('classifyIncomingDecryptError - a frame for a group we were removed from', () => {
  it('reads the EVICTED token, and reads it FIRST', () => {
    expect(classifyIncomingDecryptError(new Error('EVICTED: 4ca35caf'))).toBe('evicted');
    // The native layer wraps a refusal as `GAP_QUEUED:<group>:<error>`. An evicted frame carrying
    // both markers must still be an eviction: read as an epoch gap it goes to a commit replay that
    // applies nothing, and the group's whole retained backlog then storms that replay one frame at
    // a time. Same precedence bug as `TooDistantInTheFuture` (WP-PENDING-2), one kind later.
    expect(classifyIncomingDecryptError('GAP_QUEUED:g1:EVICTED: g1')).toBe('evicted');
  });

  it('does not read the raw OpenMLS wording as an eviction', () => {
    // Classified in Rust, on the variant. If that arm is ever removed, THIS fails rather than the
    // classifier quietly still working through the underlying prose.
    expect(
      classifyIncomingDecryptError(new Error('Process error: GroupStateError(UseAfterEviction)'))
    ).toBe('unknown');
  });
});
