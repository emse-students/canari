import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import enI18n from 'emoji-picker-element/i18n/en';

/**
 * The library's own English strings, used as the BASE the translated overrides are spread onto.
 *
 * THIS EXISTS BECAUSE ONE MISSING KEY CRASHED THE PICKER, in production, on every reaction.
 * `emoji-picker-element` runs `state.i18n.skinToneLabel.replace('{skinTone}', ...)` inside one of
 * its own effects, and our two hand-written objects defined thirteen of its fourteen keys -
 * `skinToneLabel` was the one nobody noticed. The effect also depends on `currentSkinTone`, which
 * is written asynchronously once the emoji database has loaded, so it did not throw at import
 * time: it threw when the picker was opened, as `TypeError: Cannot read properties of undefined
 * (reading 'replace')`, from inside the library where no stack frame named us.
 *
 * Adding the missing key would fix today and not tomorrow: the next version of the library that
 * adds a fifteenth key would break the same way. Spreading its defaults makes a missing key
 * IMPOSSIBLE rather than merely absent, which is the only version of this worth writing.
 *
 * Shared between every `<emoji-picker>` mount in the app (reactions AND the composer) - a second
 * hand-written copy is exactly how `skinToneLabel` went missing the first time.
 */
const EMOJI_PICKER_BASE_I18N = enI18n;

/**
 * The picker's own interface strings, for whichever locale is live.
 *
 * `emoji-picker-element` translates NOTHING from its `locale` attribute - that attribute only picks
 * the data source's search keywords - so the `i18n` property has to be set explicitly or the search
 * box reads "Search" in French. Until 2026-09-18 that was two hand-written objects and a
 * `getLocale()` branch, which is Paraglide's job done twice by hand: a key added to one table and
 * forgotten in the other was silent, and the same class of omission is what cost the picker a
 * production crash (see above).
 *
 * It is a FUNCTION rather than a constant because `m.*()` reads the locale at CALL time; a
 * module-level object would freeze whichever locale happened to be live at import.
 */
export function emojiPickerI18n() {
  return {
    ...EMOJI_PICKER_BASE_I18N,
    categoriesLabel: m.emoji_picker_categories_label(),
    emojiUnsupportedMessage: m.emoji_picker_unsupported_message(),
    favoritesLabel: m.emoji_picker_favorites_label(),
    loadingMessage: m.emoji_picker_loading_message(),
    networkErrorMessage: m.emoji_picker_network_error_message(),
    regionLabel: m.emoji_picker_region_label(),
    searchDescription: m.emoji_picker_search_description(),
    searchLabel: m.emoji_picker_search_label(),
    searchResultsLabel: m.emoji_picker_search_results_label(),
    skinToneDescription: m.emoji_picker_skin_tone_description(),
    skinTonesLabel: m.emoji_picker_skin_tones_label(),
    skinTones: [
      m.emoji_picker_skin_tone_default(),
      m.emoji_picker_skin_tone_light(),
      m.emoji_picker_skin_tone_medium_light(),
      m.emoji_picker_skin_tone_medium(),
      m.emoji_picker_skin_tone_medium_dark(),
      m.emoji_picker_skin_tone_dark(),
    ],
    categories: {
      custom: m.emoji_picker_category_custom(),
      'smileys-emotion': m.emoji_picker_category_smileys_emotion(),
      'people-body': m.emoji_picker_category_people_body(),
      'animals-nature': m.emoji_picker_category_animals_nature(),
      'food-drink': m.emoji_picker_category_food_drink(),
      'travel-places': m.emoji_picker_category_travel_places(),
      activities: m.emoji_picker_category_activities(),
      objects: m.emoji_picker_category_objects(),
      symbols: m.emoji_picker_category_symbols(),
      flags: m.emoji_picker_category_flags(),
    },
  };
}

/** The self-hosted emojibase dataset for the current locale - never `undefined` (see git history: an
 * absent attribute was an outbound call to a third-party CDN on every picker open). */
export function emojiPickerDataSource(): string {
  return getLocale() === 'en' ? '/emoji-data-en.json' : '/emoji-data-fr.json';
}

/**
 * Wires an `<emoji-picker>` element's i18n (as a JS property, so the web component picks up the
 * translation - an attribute would not) and forwards its `emoji-click` event to `onEmoji`, along
 * with whether Shift was held.
 *
 * `emoji-click`'s own detail (`EmojiClickEventDetail`) carries no modifier-key information - it is
 * the library's synthetic event, dispatched from code, not the click itself. So the click that
 * caused it is caught separately, in the CAPTURE phase on this same host element: capture runs
 * while the event travels down TOWARD the target, before the library's own internal listener (deep
 * in the shadow root) has run and dispatched `emoji-click` - a bubble-phase listener here would
 * read this click's `shiftKey` only after that dispatch, which is one click too late.
 */
export function attachEmojiPicker(
  node: HTMLElement,
  onEmoji: (emoji: string, shiftKey: boolean) => void
) {
  (node as unknown as { i18n: ReturnType<typeof emojiPickerI18n> }).i18n = emojiPickerI18n();

  let lastClickShiftKey = false;
  const handleCapturedClick = (event: Event) => {
    lastClickShiftKey = event instanceof MouseEvent && event.shiftKey;
  };
  node.addEventListener('click', handleCapturedClick, true);

  const handleEmoji = (event: CustomEvent<{ unicode: string }>) =>
    onEmoji(event.detail.unicode, lastClickShiftKey);
  node.addEventListener('emoji-click', handleEmoji as EventListener);

  return {
    destroy() {
      node.removeEventListener('click', handleCapturedClick, true);
      node.removeEventListener('emoji-click', handleEmoji as EventListener);
    },
  };
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
