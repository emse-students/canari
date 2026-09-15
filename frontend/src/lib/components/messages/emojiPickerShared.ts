import { getLocale } from '$lib/paraglide/runtime';
import enI18n from 'emoji-picker-element/i18n/en';

/**
 * The library's own English strings, used as the BASE both locale overrides are spread onto.
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
 * French UI strings for emoji-picker-element. The `locale` attribute alone does NOT
 * translate the interface (only the data-source provides localized search keywords),
 * so the `i18n` property must be set explicitly - otherwise the search box reads "Search".
 */
export const EMOJI_PICKER_FR_I18N = {
  ...EMOJI_PICKER_BASE_I18N,
  categoriesLabel: 'Catégories',
  emojiUnsupportedMessage: 'Votre navigateur ne supporte pas les emojis en couleur.',
  favoritesLabel: 'Favoris',
  loadingMessage: 'Chargement…',
  networkErrorMessage: 'Impossible de charger les emojis.',
  regionLabel: "Sélecteur d'emoji",
  searchDescription:
    'Quand des résultats sont disponibles, utilisez les flèches haut/bas et Entrée pour sélectionner.',
  searchLabel: 'Recherche',
  searchResultsLabel: 'Résultats de recherche',
  skinToneDescription:
    'Quand le sélecteur est ouvert, utilisez les flèches haut/bas et Entrée pour sélectionner.',
  skinTonesLabel: 'Tons de peau',
  skinTones: ['Défaut', 'Clair', 'Moyen-clair', 'Moyen', 'Moyen-foncé', 'Foncé'],
  categories: {
    custom: 'Personnalisé',
    'smileys-emotion': 'Smileys et émotions',
    'people-body': 'Personnes et corps',
    'animals-nature': 'Animaux et nature',
    'food-drink': 'Nourriture et boissons',
    'travel-places': 'Voyages et lieux',
    activities: 'Activités',
    objects: 'Objets',
    symbols: 'Symboles',
    flags: 'Drapeaux',
  },
};

export const EMOJI_PICKER_EN_I18N = {
  ...EMOJI_PICKER_BASE_I18N,
  categoriesLabel: 'Categories',
  emojiUnsupportedMessage: 'Your browser does not support color emoji.',
  favoritesLabel: 'Favorites',
  loadingMessage: 'Loading…',
  networkErrorMessage: 'Could not load emoji.',
  regionLabel: 'Emoji picker',
  searchDescription:
    'When search results are available, press up or down to select and enter to choose.',
  searchLabel: 'Search',
  searchResultsLabel: 'Search results',
  skinToneDescription: 'When expanded, press up or down to select and enter to choose.',
  skinTonesLabel: 'Skin tones',
  skinTones: ['Default', 'Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'],
  categories: {
    custom: 'Custom',
    'smileys-emotion': 'Smileys & Emotion',
    'people-body': 'People & Body',
    'animals-nature': 'Animals & Nature',
    'food-drink': 'Food & Drink',
    'travel-places': 'Travel & Places',
    activities: 'Activities',
    objects: 'Objects',
    symbols: 'Symbols',
    flags: 'Flags',
  },
};

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
  const i18n = getLocale() === 'en' ? EMOJI_PICKER_EN_I18N : EMOJI_PICKER_FR_I18N;
  (node as unknown as { i18n: typeof EMOJI_PICKER_FR_I18N }).i18n = i18n;

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
