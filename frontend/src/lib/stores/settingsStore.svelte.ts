/**
 * Persistent user preferences store, backed by localStorage.
 * Defaults to enabled for all settings if no saved value exists.
 */

const SOUNDS_KEY = 'canari_sounds_enabled';
const VIBRATIONS_KEY = 'canari_vibrations_enabled';

function readBool(key: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(key) !== 'false';
}

let soundsEnabled = $state(readBool(SOUNDS_KEY));
let vibrationsEnabled = $state(readBool(VIBRATIONS_KEY));

function persist(key: string, value: boolean): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, String(value));
  }
}

export const settings = {
  get soundsEnabled(): boolean {
    return soundsEnabled;
  },
  /** Persists the sounds enabled preference to localStorage. */
  setSoundsEnabled(value: boolean): void {
    soundsEnabled = value;
    persist(SOUNDS_KEY, value);
  },

  get vibrationsEnabled(): boolean {
    return vibrationsEnabled;
  },
  /** Persists the vibrations enabled preference to localStorage. */
  setVibrationsEnabled(value: boolean): void {
    vibrationsEnabled = value;
    persist(VIBRATIONS_KEY, value);
  },
};
