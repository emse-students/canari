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

function graphemeClusters(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
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
  const clusters = graphemeClusters(stripped);
  if (clusters.length === 0 || clusters.length > maxCount) return false;
  return clusters.every((cluster) => EMOJI_PATTERN.test(cluster));
}
