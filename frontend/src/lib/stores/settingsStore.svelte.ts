/**
 * Persistent user preferences store, backed by localStorage.
 * Defaults to enabled for all settings if no saved value exists.
 */

const SOUNDS_KEY = 'canari_sounds_enabled';
const VIBRATIONS_KEY = 'canari_vibrations_enabled';
const POST_FEED_KEY = 'canari_preferred_post_feed';

function readBool(key: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(key) !== 'false';
}

/**
 * Reads a stored string, or null when nothing is stored.
 *
 * Deliberately UNVALIDATED. This store knows what a preference is WORTH KEEPING, not what a valid
 * value looks like: the feed names live in `$lib/posts/api`, and importing that module here would
 * make every page carrying a sound toggle depend on the posts API. The owner of the vocabulary
 * validates - see `parsePostFeed` - and this file stays a store.
 */
function readString(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

let soundsEnabled = $state(readBool(SOUNDS_KEY));
let vibrationsEnabled = $state(readBool(VIBRATIONS_KEY));
let preferredPostFeed = $state(readString(POST_FEED_KEY));

function persist(key: string, value: boolean | string): void {
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

  /**
   * The posts feed tab last chosen, verbatim, or null when none ever was.
   *
   * A RAW STRING AND NOT A `PostFeed` (user, 2026-09-10: *"L'onglet du fil doit survivre a une
   * autre session"*). It comes back off `localStorage`, where a previous build, another tab or a
   * hand edit could have left anything - so it is exactly as untrusted as a query parameter, and
   * it is narrowed by the module that owns the vocabulary rather than here.
   *
   * PER DEVICE, which is what `localStorage` can promise: this is the same storage the sound and
   * vibration preferences use, and the account carries no server-side preference record. A new
   * session in the same browser keeps the tab; a different browser starts at the default.
   */
  get preferredPostFeed(): string | null {
    return preferredPostFeed;
  },
  /** Persists the posts feed tab so the next session opens on it. */
  setPreferredPostFeed(value: string): void {
    preferredPostFeed = value;
    persist(POST_FEED_KEY, value);
  },
};
