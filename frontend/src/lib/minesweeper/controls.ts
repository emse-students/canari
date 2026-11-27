/**
 * THE TWO GESTURES, shared by the game and the tutorial (owner, 2026-11-27: *"laisser a l'utilisateur decider
 * la premiere fois ce qu'il prefere -> synchroniser avec les parametres pour la suite du jeu"*). A short press
 * (a left click) does one action and a long press (a right click) the other; `flagPrimary` says which: false,
 * the short press digs; true, it flags. ONE storage key, so the choice made in the tutorial is the game's.
 */

export const FLAG_PRIMARY_STORAGE_KEY = 'canari.minesweeper.flagPrimary';

/** The stored choice, or null when the player never made one (the tutorial then asks). */
export function loadFlagPrimary(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  const stored = localStorage.getItem(FLAG_PRIMARY_STORAGE_KEY);
  return stored === '1' ? true : stored === '0' ? false : null;
}

export function saveFlagPrimary(flagPrimary: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FLAG_PRIMARY_STORAGE_KEY, flagPrimary ? '1' : '0');
  console.debug('[minesweeper-controls] short press now', flagPrimary ? 'flags' : 'digs');
}

/**
 * Whether this device is played with a finger (a long press) rather than a mouse (a right click), to NAME
 * the gestures; both work everywhere.
 */
export function playedByTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
