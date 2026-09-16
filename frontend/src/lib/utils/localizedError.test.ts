import { describe, expect, it } from 'vitest';
import { LocalizedError, localizedMessage } from './localizedError';
import { ServerUnreachableError, isServerUnreachable } from './fetchOrUnreachable';
import { LoginFailure } from '$lib/composables/session/loginErrors';
import { SessionExpiredError } from '$lib/stores/auth';

/**
 * THE TYPE ANSWERS ONE QUESTION: MAY THIS MESSAGE BE SHOWN?
 *
 * Both directions have already cost something, so both are asserted: an `Error` that is NOT
 * localized must never reach a screen (`Failed to fetch` on the PIN modal read like "your PIN is
 * wrong"), and one that IS localized must not be swallowed into a generic line (six precise PIN
 * refusals would become one vague sentence).
 */
const FALLBACK = 'the line this screen declares';

describe('localizedMessage', () => {
  it('shows a LocalizedError as it was thrown', () => {
    expect(localizedMessage(new LocalizedError('Le PIN actuel est incorrect.'), FALLBACK)).toBe(
      'Le PIN actuel est incorrect.'
    );
  });

  it.each([
    [new TypeError('Failed to fetch')],
    [new Error('calls/initiate failed (403): forbidden')],
    ['a bare string'],
    [null],
    [undefined],
    [{ message: 'an object wearing the right shape' }],
  ])('replaces %s with the declared line', (thrown) => {
    expect(localizedMessage(thrown, FALLBACK)).toBe(FALLBACK);
  });

  it('shows a ServerUnreachableError, because its message is the caller s own line', () => {
    // The class that already worked this way, and the reason it is a SUBCLASS rather than a
    // sibling: `fetchOrUnreachable` is handed a Paraglide line by each call site.
    const error = new ServerUnreachableError('Serveur injoignable.', new TypeError('nope'));

    expect(error).toBeInstanceOf(LocalizedError);
    expect(localizedMessage(error, FALLBACK)).toBe('Serveur injoignable.');
  });

  it('shows a LoginFailure, whose six throws all build a Paraglide sentence', () => {
    // The login catch renders whatever it caught into the sign-in error field, and the SAME `try`
    // also catches a `SessionExpiredError` carrying "Session expired - please log in again" and a
    // `TypeError` from a dead socket. Both halves of that were live: the English reached a French
    // reader, and dropping the preference outright would have replaced "that is not your current
    // PIN" with a vague line. The code it already carried says WHY; the type says the message is
    // the reader's.
    const refusal = new LoginFailure('pin_mismatch', 'Le PIN est incorrect.');

    expect(refusal).toBeInstanceOf(LocalizedError);
    expect(refusal.code).toBe('pin_mismatch');
    expect(localizedMessage(refusal, FALLBACK)).toBe('Le PIN est incorrect.');
    expect(localizedMessage(new SessionExpiredError(), FALLBACK)).toBe(FALLBACK);
  });

  it('keeps "could not reach" narrower than "may be shown"', () => {
    // Widening `isServerUnreachable` to every LocalizedError would put a wrong PIN in the same
    // bucket as a train tunnel, which is the distinction `fetchOrUnreachable` exists to draw.
    expect(isServerUnreachable(new LocalizedError('Le PIN actuel est incorrect.'))).toBe(false);
    expect(isServerUnreachable(new ServerUnreachableError('x', null))).toBe(true);
  });

  it('is an Error, so nothing downstream has to special-case it', () => {
    const error = new LocalizedError('une phrase');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LocalizedError');
    expect(error.message).toBe('une phrase');
  });
});
