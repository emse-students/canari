/**
 * Turns a run of text into text and emoji PICTURES - the one place the app decides which grapheme is
 * drawn as an SVG from `/emoji/` rather than by the platform's font.
 *
 * WHY PICTURES (user, 2026-09-25): the bundled colour font never drew on WebKit, and an `<img>` of
 * an SVG is drawn identically by every engine. The pictures and `emojiSvgNames.json` are produced by
 * `tools/emoji-svg/build.mjs` from a pinned Noto checkout; see `docs/wiki/frontend/emoji.md`.
 *
 * TWO GATES, BOTH REQUIRED, IN THIS ORDER:
 *
 * 1. **Emoji presentation.** Noto draws `©`, `™`, `↔` and every digit, and in `© 2026` those are
 *    TEXT. A grapheme is a picture when it carries U+FE0F, or a skin-tone modifier, or when its first
 *    code point is NOT one whose default presentation is text. That last list (`textDefault`) ships
 *    in the JSON, computed by `tools/emoji-svg/build.mjs`: asking `\p{Emoji_Presentation}` at runtime
 *    answers from the ENGINE's Unicode tables, and an older WebView does not know the newest emoji
 *    are emoji - it would have drawn them as text while holding their picture (measured under Node,
 *    whose tables miss seven Unicode 16 entries the picker offers).
 * 2. **A picture exists.** The name must be on the list the build wrote. A sequence newer than the
 *    pinned Noto, or a well-formed but unassigned one, stays text rather than becoming a broken image.
 */
import emojiSet from './emojiSvgNames.json';

const AVAILABLE: ReadonlySet<string> = new Set(emojiSet.names);
const TEXT_DEFAULT: ReadonlySet<number> = new Set(
  emojiSet.textDefault.map((hex) => parseInt(hex, 16))
);

/** U+FE0F VARIATION SELECTOR-16: asks for emoji presentation, and never part of a file name. */
const VS16 = 0xfe0f;
/** The five skin-tone modifiers: a modifier sequence presents as an emoji whatever its base. */
const FIRST_MODIFIER = 0x1f3fb;
const LAST_MODIFIER = 0x1f3ff;

/**
 * Where the pictures are served from, in the app and on the web alike (`static/emoji/<set>/`).
 * `set` hashes every name and byte, so this URL changes whenever a picture does - which is what
 * makes the year-long `immutable` on nginx's `/emoji/` block safe.
 */
export const EMOJI_SVG_BASE = `/emoji/${emojiSet.set}/`;

/** A piece of a text run: either text to print as-is, or one emoji grapheme drawn as a picture. */
export type EmojiTextPart =
  | { kind: 'text'; value: string }
  | { kind: 'emoji'; value: string; src: string };

let segmenter: Intl.Segmenter | null = null;
function graphemes(text: string): Iterable<string> {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * The picture's file name for one grapheme: its code points in lower-case hex, padded to four
 * digits, joined by `_`, every U+FE0F removed - Noto's own naming minus its `emoji_u` prefix.
 */
export function emojiSvgName(grapheme: string): string {
  const parts: string[] = [];
  for (const char of grapheme) {
    const cp = char.codePointAt(0)!;
    if (cp !== VS16) parts.push(cp.toString(16).padStart(4, '0'));
  }
  return parts.join('_');
}

/** Whether this grapheme presents as an emoji rather than as text (gate 1 above). */
export function presentsAsEmoji(grapheme: string): boolean {
  let first: number | undefined;
  for (const char of grapheme) {
    const cp = char.codePointAt(0)!;
    first ??= cp;
    if (cp === VS16 || (cp >= FIRST_MODIFIER && cp <= LAST_MODIFIER)) return true;
  }
  return first !== undefined && !TEXT_DEFAULT.has(first);
}

/** The URL of this grapheme's picture, or `null` when it is text (either gate refusing). */
export function emojiSvgSrc(grapheme: string): string | null {
  if (!presentsAsEmoji(grapheme)) return null;
  const name = emojiSvgName(grapheme);
  return AVAILABLE.has(name) ? `${EMOJI_SVG_BASE}${name}.svg` : null;
}

/**
 * Splits `text` into text runs and emoji pictures. Adjacent text graphemes are merged back into one
 * run, so a sentence with no emoji comes back as exactly one part and costs one text node.
 */
export function splitEmojiText(text: string): EmojiTextPart[] {
  const parts: EmojiTextPart[] = [];
  let run = '';
  for (const grapheme of graphemes(text)) {
    const src = emojiSvgSrc(grapheme);
    if (src === null) {
      run += grapheme;
      continue;
    }
    if (run) parts.push({ kind: 'text', value: run });
    run = '';
    parts.push({ kind: 'emoji', value: grapheme, src });
  }
  if (run) parts.push({ kind: 'text', value: run });
  return parts;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/**
 * `text` as ESCAPED HTML, every emoji an `<img>` of its picture - for the exports that build their
 * markup as a string (the calendar, the trombinoscope) rather than through `EmojiText`.
 *
 * The picture's size is inlined: those sheets are rasterised off-page by snapdom, and the style an
 * export paints must not depend on a stylesheet reaching the serialised copy.
 */
export function emojiHtml(text: string): string {
  return splitEmojiText(text)
    .map((part) =>
      part.kind === 'text'
        ? escapeHtml(part.value)
        : `<img class="emoji" src="${part.src}" alt="${part.value}" draggable="false" style="display:inline-block;width:1.2em;height:1.2em;vertical-align:-0.2em">`
    )
    .join('');
}
