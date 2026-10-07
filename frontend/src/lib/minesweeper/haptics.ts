/** Vibration patterns (ms) for the moments of a game worth feeling. */
export const HAPTIC_FLAG = 12;
export const HAPTIC_LONG_PRESS = 18;
export const HAPTIC_LOSS = [60, 40, 120];
export const HAPTIC_WIN = [25, 40, 25, 40, 80];

/**
 * Vibrates when the device can. Only ever called from a gesture handler or its consequence, because
 * Chrome refuses `navigator.vibrate` before a user activation and reports it as a console error.
 * A refusal is logged at debug level: haptics are a nicety, never a path the game depends on.
 */
export function haptic(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch (err) {
    console.debug('[minesweeper] vibrate refused', err);
  }
}
