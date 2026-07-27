/**
 * PIN policy: a PIN is 4 to 8 digits.
 *
 * The policy is enforced where a PIN is CREATED (first setup, change, recovery), never where an
 * existing one is typed to unlock. PINs chosen before this policy existed may be longer or
 * contain non-digits, and their owners must still be able to sign in - the device key derives
 * from whatever string they picked, so rejecting it at the input would lock them out of their
 * own messages. Hence two checks: {@link isValidPin} (permissive, unlock) and
 * {@link isValidNewPin} (strict, creation).
 */

/** Shortest accepted PIN, on both the unlock and the creation path. */
export const MIN_PIN_LENGTH = 4;

/** Longest PIN the creation path accepts. Not applied to unlock (see module doc). */
export const MAX_PIN_LENGTH = 8;

const NEW_PIN_PATTERN = new RegExp(`^\\d{${MIN_PIN_LENGTH},${MAX_PIN_LENGTH}}$`);

/**
 * True when `pin` is long enough to be worth submitting as an unlock attempt.
 * Deliberately accepts legacy PINs of any length and any character set.
 */
export function isValidPin(pin: string): boolean {
  return pin.trim().length >= MIN_PIN_LENGTH;
}

/** True when `pin` satisfies the creation policy: {@link MIN_PIN_LENGTH} to {@link MAX_PIN_LENGTH} digits. */
export function isValidNewPin(pin: string): boolean {
  return NEW_PIN_PATTERN.test(pin.trim());
}
