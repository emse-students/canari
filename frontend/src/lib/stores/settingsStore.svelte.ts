/**
 * Persistent user preferences store, backed by localStorage.
 * Defaults to enabled for all settings if no saved value exists.
 */

const SOUNDS_KEY = 'canari_sounds_enabled';

function readSoundsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(SOUNDS_KEY) !== 'false';
}

let soundsEnabled = $state(readSoundsEnabled());

export const settings = {
  get soundsEnabled(): boolean {
    return soundsEnabled;
  },
  /** Persists the sounds enabled preference to localStorage. */
  setSoundsEnabled(value: boolean): void {
    soundsEnabled = value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SOUNDS_KEY, String(value));
    }
  },
};
