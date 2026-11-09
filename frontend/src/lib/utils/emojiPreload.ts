import { emojiPictureSrc } from '$lib/utils/emojiStyle';
import {
  EMOJI_CATEGORIES,
  loadEmojiCatalog,
  withSkinTone,
  type EmojiEntry,
  type SkinTone,
} from '$lib/utils/emojiCatalog';

/**
 * HOW MANY CELLS OF THE FIRST CATEGORY THE PICKER SHOWS BEFORE ANY SCROLL (8 columns, about 7 rows
 * in the 18 rem scroll area). They are fetched eagerly and decoded synchronously by `EmojiGrid`, and
 * warmed by `warmEmojiPicker` - the same number in both places, so what is painted at once is what
 * was fetched ahead.
 */
export const FIRST_SCREEN_EMOJI_COUNT = 64;

/** The URLs already handed to an `Image`, so a second warm-up costs nothing. */
const warmed = new Set<string>();
/** Held so the engine keeps the decoded bitmaps it may otherwise drop. */
const held: HTMLImageElement[] = [];

/** Fetches and decodes the pictures at `sources` once each; never throws (a miss only costs a late cell). */
export function warmEmojiPictures(sources: readonly (string | null)[]): void {
  if (typeof Image === 'undefined') return;
  for (const src of sources) {
    if (!src || warmed.has(src)) continue;
    warmed.add(src);
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.src = src;
    held.push(img);
    void img.decode().catch((e) => console.debug('[EMOJI] warm-up decode failed', src, e));
  }
}

/** The pictures the picker paints on open: the first screen of the first category, and one icon per tab. */
export function firstScreenEmoji(entries: readonly EmojiEntry[], tone: SkinTone): string[] {
  const first = entries.filter((entry) => entry.category === EMOJI_CATEGORIES[0]);
  return first.slice(0, FIRST_SCREEN_EMOJI_COUNT).map((entry) => withSkinTone(entry, tone));
}

/** One representative emoji per category - what the tab bar draws. */
export function tabIconEmoji(entries: readonly EmojiEntry[]): string[] {
  return EMOJI_CATEGORIES.flatMap((category) => {
    const entry = entries.find((e) => e.category === category);
    return entry ? [entry.emoji] : [];
  });
}

/**
 * Runs `task` once the page has painted a frame and the main thread is idle. A SCHEDULING CHOICE,
 * NOT A LOAD-BEARING TIMER: no signal marks "the salon's first render is done" (the community-open
 * bench reads its marks from the outside), and nothing breaks if this runs later or never - the
 * picker then paints its own eager first screen. WKWebView has no `requestIdleCallback`, so it
 * falls back to the task after one painted frame.
 */
export function whenIdleAfterPaint(task: () => void): void {
  if (typeof window === 'undefined') return;
  const run = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(task);
    else setTimeout(task, 0);
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/**
 * Called by a composer AFTER its first paint (never at mount: that is the community-open window,
 * a P1 budget), so the picker opens onto pictures that are already in the cache
 * instead of fetching 70-odd SVGs on the tap that opens it (the iPhone showed blank and growing
 * cells, 2026-11-08). Bounded: the catalogue is the one the picker loads anyway, and the pictures
 * are the first screen, the tab icons and the recents - about 80 files of ~3 kB, once per session.
 * Under the "system" emoji setting no picture is drawn, so none is fetched: only the catalogue loads.
 */
export async function warmEmojiPicker(
  dataSource: string,
  tone: SkinTone,
  recents: readonly string[]
): Promise<void> {
  try {
    const entries = await loadEmojiCatalog(dataSource);
    warmEmojiPictures(
      [...recents, ...tabIconEmoji(entries), ...firstScreenEmoji(entries, tone)].map((emoji) =>
        emojiPictureSrc(emoji)
      )
    );
  } catch (e) {
    console.warn('[EMOJI] picker warm-up failed', e);
  }
}
