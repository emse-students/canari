import { recoveryOfStateLoadFailure, type StateLoadFailure } from './IMlsService';

/**
 * THE WHOLE TRUTH TABLE of the one decision both platforms' `init` take on a saved state that did
 * not load: every cause x whether a state exists x `noFreshStart`. Written out row by row, so a
 * change to any answer is a change to this table, visible in review.
 *
 * The rule it pins: a destructive repair (`rotate`) is gated on KNOWING the state is broken.
 */
const TABLE: [StateLoadFailure, boolean, boolean, 'rotate' | 'pause' | 'rethrow'][] = [
  // No PIN ever opens these: rotated in every case.
  ['mismatch', true, true, 'rotate'],
  ['mismatch', true, false, 'rotate'],
  ['mismatch', false, true, 'rotate'],
  ['mismatch', false, false, 'rotate'],
  ['altered', true, true, 'rotate'],
  ['altered', true, false, 'rotate'],
  ['altered', false, true, 'rotate'],
  ['altered', false, false, 'rotate'],
  // May be a PIN rotated elsewhere: `noFreshStart` chooses between pausing and rotating.
  ['rotated', true, true, 'pause'],
  ['rotated', true, false, 'rotate'],
  ['rotated', false, true, 'rethrow'],
  ['rotated', false, false, 'rethrow'],
  ['undecryptable', true, true, 'pause'],
  ['undecryptable', true, false, 'rotate'],
  ['undecryptable', false, true, 'rethrow'],
  ['undecryptable', false, false, 'rethrow'],
  // Proves nothing about the bytes: NEVER rotated, whatever the caller passes.
  ['unknown', true, true, 'pause'],
  ['unknown', true, false, 'pause'],
  ['unknown', false, true, 'rethrow'],
  ['unknown', false, false, 'rethrow'],
  ['unreadable_now', true, true, 'pause'],
  ['unreadable_now', true, false, 'pause'],
  ['unreadable_now', false, true, 'rethrow'],
  ['unreadable_now', false, false, 'rethrow'],
  // No key, so no bytes were read: the PIN modal, as itself.
  ['keystore_unavailable', true, true, 'rethrow'],
  ['keystore_unavailable', true, false, 'rethrow'],
  ['keystore_unavailable', false, true, 'rethrow'],
  ['keystore_unavailable', false, false, 'rethrow'],
];

describe('recoveryOfStateLoadFailure - the full truth table', () => {
  it('covers every cause x savedStateExists x noFreshStart exactly once', () => {
    const keys = new Set(TABLE.map(([c, s, n]) => `${c}/${s}/${n}`));
    expect(keys.size).toBe(TABLE.length);
    expect(TABLE.length).toBe(7 * 2 * 2);
  });

  it.each(TABLE)('%s, state exists %s, noFreshStart %s -> %s', (cause, exists, noFresh, want) => {
    expect(recoveryOfStateLoadFailure(cause, exists, noFresh)).toBe(want);
  });

  it('never rotates a cause that proves nothing, under any options', () => {
    for (const cause of ['unknown', 'unreadable_now', 'keystore_unavailable'] as const) {
      for (const exists of [true, false]) {
        for (const noFresh of [true, false]) {
          expect(recoveryOfStateLoadFailure(cause, exists, noFresh)).not.toBe('rotate');
        }
      }
    }
  });
});
