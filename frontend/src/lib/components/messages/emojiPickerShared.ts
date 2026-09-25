import { getLocale } from '$lib/paraglide/runtime';
import { SKIN_TONES, type SkinTone } from '$lib/utils/emojiCatalog';

/** The self-hosted emojibase dataset for the current locale - never `undefined` (see git history: an
 * absent attribute was an outbound call to a third-party CDN on every picker open). */
export function emojiPickerDataSource(): string {
  return getLocale() === 'en' ? '/emoji-data-en.json' : '/emoji-data-fr.json';
}

/** Shared across every emoji picker in the app - a reaction and a composer pick share one history. */
const RECENT_EMOJIS_KEY = 'canari_recent_emojis';

/** Reads the persisted recent-emoji list, newest first. Empty (never throws) on any storage fault. */
export function getRecentEmojis(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_EMOJIS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, 12);
  } catch {
    return [];
  }
}

/** Persists `emoji` at the front of the recent list, deduplicated, capped at 12. */
export function persistRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...getRecentEmojis().filter((item) => item !== emoji)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors - the in-memory list below still updates the caller for this session.
  }
  return next;
}

/** Shared across both pickers, like the recents: a tone chosen in one is the tone of the other. */
const SKIN_TONE_KEY = 'canari_emoji_skin_tone';

/** The persisted skin tone, `0` (no tone) when none was chosen or storage holds anything else. */
export function getPreferredSkinTone(): SkinTone {
  try {
    const stored = Number(localStorage.getItem(SKIN_TONE_KEY));
    return (SKIN_TONES as readonly number[]).includes(stored) ? (stored as SkinTone) : 0;
  } catch {
    return 0;
  }
}

/** Persists the chosen skin tone; a storage fault only costs remembering it next session. */
export function persistPreferredSkinTone(tone: SkinTone): void {
  try {
    localStorage.setItem(SKIN_TONE_KEY, String(tone));
  } catch {
    // Ignore storage errors - the picker keeps the tone for this session.
  }
}
