/**
 * Persistent user preferences store, backed by localStorage.
 * Defaults to enabled for all settings if no saved value exists.
 *
 * EVERY STORAGE ACCESS IS GUARDED: a private window, blocked site data or a full quota makes
 * `localStorage` THROW, and a preference that cannot be read or kept must never break the page
 * that reads it - the default is used, the session keeps the choice in memory, and a warning says
 * which key was lost.
 */
import { Log } from '$lib/utils/Log';

const SOUNDS_KEY = 'canari_sounds_enabled';
const VIBRATIONS_KEY = 'canari_vibrations_enabled';
const POST_FEED_KEY = 'canari_preferred_post_feed';
const SHARE_SUGGESTIONS_KEY = 'canari_share_suggestions_enabled';
const EMOJI_STYLE_KEY = 'canari_emoji_style';
const INFINITE_REELS_KEY = 'canari_infinite_reels_enabled';
const REELS_ORDER_KEY = 'canari_reels_order';
const VIDEO_AUTOPLAY_KEY = 'canari_video_autoplay';

function readBool(key: string): boolean {
  return readString(key) !== 'false';
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
  try {
    return localStorage.getItem(key);
  } catch (e) {
    Log.w('SETTINGS', `${key} could not be read - the default is used: ${String(e)}`);
    return null;
  }
}

let soundsEnabled = $state(readBool(SOUNDS_KEY));
let vibrationsEnabled = $state(readBool(VIBRATIONS_KEY));
let preferredPostFeed = $state(readString(POST_FEED_KEY));
let shareSuggestionsEnabled = $state(readBool(SHARE_SUGGESTIONS_KEY));
let emojiStyle = $state(readString(EMOJI_STYLE_KEY));
let infiniteReelsEnabled = $state(readBool(INFINITE_REELS_KEY));
let reelsOrder = $state(readString(REELS_ORDER_KEY));
let videoAutoplay = $state(readString(VIDEO_AUTOPLAY_KEY));

function persist(key: string, value: boolean | string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, String(value));
  } catch (e) {
    Log.w('SETTINGS', `${key} could not be kept - this session only: ${String(e)}`);
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
   * Whether the phone's share sheet suggests this account's recent conversations (sharing lot S5).
   * ON by default (user, 2026-10-22). Per device, like the two toggles above; the suggestions
   * themselves are erased at every sign-out whatever this says (`shareTargets.ts`).
   */
  get shareSuggestionsEnabled(): boolean {
    return shareSuggestionsEnabled;
  },
  /** Persists the share-suggestions preference to localStorage. */
  setShareSuggestionsEnabled(value: boolean): void {
    shareSuggestionsEnabled = value;
    persist(SHARE_SUGGESTIONS_KEY, value);
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

  /**
   * How emoji are drawn - the system font's glyphs or Canari's own pictures - verbatim, or null
   * when never chosen. Narrowed by `$lib/utils/emojiStyle`, the module that owns the vocabulary
   * and the one place the choice is applied.
   *
   * READ HERE, AT MODULE LOAD, SYNCHRONOUSLY: the first message drawn already knows which emoji to
   * draw, so no picture is fetched and then replaced. Per device, like the theme it sits beside: a
   * display preference follows the screen it is seen on, and the account carries no preference record.
   */
  get emojiStyle(): string | null {
    return emojiStyle;
  },
  /** Persists the emoji drawing preference. */
  setEmojiStyle(value: string): void {
    emojiStyle = value;
    persist(EMOJI_STYLE_KEY, value);
  },

  /**
   * "Défilement infini des CanaReels" ("Nos principes", owner 2026-11-10, principle 3: no trap
   * scrolling): ON, a feed video opened full screen runs on into the CanaReels list; OFF, the viewer
   * shows that post's media only. ON by default. Per device, like every display preference here.
   */
  get infiniteReelsEnabled(): boolean {
    return infiniteReelsEnabled;
  },
  /** Persists the infinite-reels preference. */
  setInfiniteReelsEnabled(value: boolean): void {
    infiniteReelsEnabled = value;
    persist(INFINITE_REELS_KEY, value);
  },

  /**
   * The CanaReels stream's order last chosen ("Pour toi" or "Récents", owner 2026-11-10), verbatim,
   * or null when none ever was - narrowed by `$lib/reels/reelOrder`, as the feed tab is by
   * `parsePostFeed`. Per device, remembered like the feed's tab.
   */
  get reelsOrder(): string | null {
    return reelsOrder;
  },
  /** Persists the CanaReels order so the next opening starts on it. */
  setReelsOrder(value: string): void {
    reelsOrder = value;
    persist(REELS_ORDER_KEY, value);
  },

  /**
   * "Lecture automatique des vidéos" (owner, 2026-11-10), verbatim, or null when never chosen -
   * narrowed by `$lib/video/autoplayPolicy`, the one place it is applied. Per device: the network a
   * video would spend is this device's.
   */
  get videoAutoplay(): string | null {
    return videoAutoplay;
  },
  /** Persists the autoplay preference. */
  setVideoAutoplay(value: string): void {
    videoAutoplay = value;
    persist(VIDEO_AUTOPLAY_KEY, value);
  },
};
