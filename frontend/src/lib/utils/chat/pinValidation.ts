/**
 * PIN policy: a PIN is at least 4 characters, with no upper bound and no character-set
 * restriction.
 *
 * The single rule applies to both creation and unlock on purpose. The device key derives from
 * the exact string the user typed, so any check that a PIN could pass at creation but fail at
 * unlock would lock its owner out of their own messages - including PINs chosen before this
 * module existed, which may be longer or alphanumeric.
 */

/** Shortest accepted PIN, on the creation and the unlock path alike. */
export const MIN_PIN_LENGTH = 4;

/** True when `pin` is long enough to be accepted, whether it is being created or entered. */
export function isValidPin(pin: string): boolean {
  return pin.trim().length >= MIN_PIN_LENGTH;
}
