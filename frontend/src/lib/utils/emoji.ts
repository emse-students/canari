/**
 * Shared "is this emoji" primitive, built on `Intl.Segmenter` grapheme clusters (which correctly
 * group a ZWJ family, a skin-toned person or a flag pair as ONE unit each) plus the Unicode
 * `Extended_Pictographic` / `Regional_Indicator` properties - no dataset lookup, so it works for
 * any codepoint the bundled font covers, not just the picker's offered set.
 *
 * Two callers share this: the PDF export's per-node rasterization decision (`searchableRaster.ts`,
 * a color emoji cannot be embedded as vector text) and jumbomoji (`MessageBubble.svelte`, an
 * emoji-only message drops its bubble and renders larger).
 */

const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * ONE SEGMENTER FOR THE PAGE, built on first use. Constructing an `Intl.Segmenter` is the expensive
 * half of a grapheme split (it loads the locale's break rules), and `isEmojiOnlyText` used to build
 * one per call - once per message bubble mounted, the largest named function of a salon open after
 * the bubbles themselves (community-open-budget, 2026-11-08). A segmenter holds no per-call state.
 */
let segmenter: Intl.Segmenter | null = null;

/**
 * The grapheme clusters of `text`, LAZILY: a caller that stops early pays only for what it read,
 * whatever the length of the text. The one grapheme split of the app (`emojiSvg.ts` uses it too).
 */
export function* graphemes(text: string): Generator<string> {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of segmenter.segment(text)) yield segment;
}

/** True if `text` contains at least one emoji grapheme, anywhere. */
export function containsEmoji(text: string): boolean {
  return EMOJI_PATTERN.test(text);
}

/**
 * True if `text` (whitespace stripped) is 1 to `maxCount` emoji graphemes and nothing else - no
 * other character survives the strip. Empty or whitespace-only text is never emoji-only.
 */
export function isEmojiOnlyText(text: string, maxCount: number): boolean {
  const stripped = text.replace(/\s+/gu, '');
  if (!stripped) return false;
  // BOUNDED BY `maxCount`, NOT BY THE TEXT: the scan stops at the first grapheme that is not an
  // emoji (the first letter of an ordinary message) or at the one past `maxCount`, so a long
  // message costs what a short one does.
  let count = 0;
  for (const cluster of graphemes(stripped)) {
    if (++count > maxCount || !EMOJI_PATTERN.test(cluster)) return false;
  }
  return count > 0;
}
