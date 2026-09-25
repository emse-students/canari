/**
 * The emoji picker's catalogue: the self-hosted emojibase dataset, grouped, searchable, skin-toned.
 *
 * It replaced `emoji-picker-element` on 2026-09-25, because that library draws with a FONT and the
 * app now draws Noto's pictures (`docs/wiki/frontend/emoji.md`). What the library did for us is
 * done here, and nothing more: the ten emojibase groups minus "component" (the bare skin-tone and
 * hair swatches are not emoji anyone picks), in the dataset's own order; one skin tone applied to
 * every entry that has skins; and search under the ecosystem's contract (`tolerantSearch.ts`).
 *
 * The data is the pinned `emoji-picker-element-data` package, copied to `static/` byte for byte by
 * `tools/emoji-data/sync.mjs` - unchanged by this rewrite.
 */
import { emojiSvgSrc } from './emojiSvg';
import { searchTokens } from './tolerantSearch';

/** The category keys, in display order; each names its `m.emoji_picker_category_*` label. */
export const EMOJI_CATEGORIES = [
  'smileys-emotion',
  'people-body',
  'animals-nature',
  'food-drink',
  'travel-places',
  'activities',
  'objects',
  'symbols',
  'flags',
] as const;
export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];

/** emojibase group number -> category. Group 2 ("component") is absent on purpose (see header). */
const GROUP_TO_CATEGORY: Record<number, EmojiCategory> = {
  0: 'smileys-emotion',
  1: 'people-body',
  3: 'animals-nature',
  4: 'food-drink',
  5: 'travel-places',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
};

/** 0 is "no tone" (the yellow default); 1-5 are Fitzpatrick 1-2 through 6, as emojibase numbers them. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;
export const SKIN_TONES: readonly SkinTone[] = [0, 1, 2, 3, 4, 5];

/** One entry of the emojibase compact dataset, as `static/emoji-data-*.json` stores it. */
export interface DatasetEntry {
  emoji: string;
  annotation: string;
  group?: number;
  order?: number;
  tags?: string[];
  shortcodes?: string[];
  skins?: { emoji: string; tone: number | number[] }[];
}

/** An entry the picker can offer: it has a category and a picture. */
export interface EmojiEntry {
  emoji: string;
  annotation: string;
  category: EmojiCategory;
  /** Folded search words: annotation, tags and shortcodes. */
  words: string[];
  /** Tone -> the skin-toned emoji, for the tones this entry has. */
  skins: Partial<Record<Exclude<SkinTone, 0>, string>>;
}

/**
 * The emoji to show for `entry` at `tone`: its variant at exactly that tone, else the default.
 * A multi-person variant counts only when EVERY person has that tone - the picker offers one tone at
 * a time, as the library did; the mixed pairs are not reachable from it.
 */
export function withSkinTone(entry: EmojiEntry, tone: SkinTone): string {
  return tone === 0 ? entry.emoji : (entry.skins[tone] ?? entry.emoji);
}

/** Turns the raw dataset into the picker's entries, dropping what it cannot place or draw. */
export function buildCatalog(dataset: readonly DatasetEntry[]): EmojiEntry[] {
  const entries: EmojiEntry[] = [];
  const ordered = [...dataset].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const raw of ordered) {
    const category = raw.group === undefined ? undefined : GROUP_TO_CATEGORY[raw.group];
    // No category is the "component" group; no picture cannot happen past `check-emoji-coverage`,
    // which fails the build for any dataset entry without one - so this drops nothing in practice.
    if (!category || emojiSvgSrc(raw.emoji) === null) continue;
    const skins: EmojiEntry['skins'] = {};
    for (const skin of raw.skins ?? []) {
      const tones = Array.isArray(skin.tone) ? skin.tone : [skin.tone];
      const tone = tones[0];
      if (tone >= 1 && tone <= 5 && tones.every((t) => t === tone) && !skins[tone as 1]) {
        skins[tone as Exclude<SkinTone, 0>] = skin.emoji;
      }
    }
    entries.push({
      emoji: raw.emoji,
      annotation: raw.annotation,
      category,
      words: searchTokens(
        [raw.annotation, ...(raw.tags ?? []), ...(raw.shortcodes ?? [])].join(' ')
      ),
      skins,
    });
  }
  return entries;
}

const loaded = new Map<string, Promise<EmojiEntry[]>>();

/**
 * The catalogue at `url` (one of the two `static/emoji-data-*.json`), fetched once per session and
 * locale. A failed fetch is not cached, so reopening the picker asks again.
 */
export function loadEmojiCatalog(url: string): Promise<EmojiEntry[]> {
  const cached = loaded.get(url);
  if (cached) return cached;
  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.json() as Promise<DatasetEntry[]>;
    })
    .then(buildCatalog);
  loaded.set(url, request);
  request.catch(() => loaded.delete(url));
  return request;
}
