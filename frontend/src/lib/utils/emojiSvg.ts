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
 * 1. **Not one of the few characters that are really TEXT.** Noto draws every digit, `#`, `*`, `©`,
 *    `®` and `™`, and in `© 2026` or `#1` those are text: they are a picture only with U+FE0F. Every
 *    other emoji is a picture with or without it - Twemoji's and Discord's rule. Unicode's own
 *    "text-default" list is 230 code points and was tried first (2026-09-25): it left `📽` (U+1F4FD),
 *    `🕶`, `🗺`, `🖥`... as text whenever a keyboard or a paste sent them without U+FE0F, which
 *    they routinely do, and every platform draws them as emoji anyway. The list is fixed here, never
 *    asked of `\p{Emoji_Presentation}`: that answers from the ENGINE's Unicode tables, and an older
 *    WebView does not know the newest emoji are emoji (measured under Node, which missed seven
 *    Unicode 16 entries the picker offers).
 * 2. **A picture exists.** The name must be on the list the build wrote. A sequence newer than the
 *    pinned Noto, or a well-formed but unassigned one, stays text rather than becoming a broken image.
 */
import emojiSet from './emojiSvgNames.json';

const AVAILABLE: ReadonlySet<string> = new Set(emojiSet.names);

/** The characters that stay text unless U+FE0F asks otherwise: `#`, `*`, `0`-`9`, `©`, `®`, `™`. */
const TEXT_UNLESS_VS16: ReadonlySet<number> = new Set([
  0x23, 0x2a, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0xa9, 0xae, 0x2122,
]);

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
  return first !== undefined && !TEXT_UNLESS_VS16.has(first);
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
