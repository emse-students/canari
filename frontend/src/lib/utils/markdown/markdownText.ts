/**
 * Character-level helpers shared by the composer preview (`inlinePreview.ts`) and the renderer's
 * tolerance (`emphasisTolerance.ts`). Kept apart so the preview never has to import the renderer.
 */

const WORD = /[\p{L}\p{N}]/u;

/** True when `ch` is a letter or a digit. */
export const isWordChar = (ch: string | undefined): boolean => !!ch && WORD.test(ch);

/** True for whitespace, and for "nothing" (a line edge reads as whitespace in CommonMark). */
export const isSpace = (ch: string | undefined): boolean => !ch || /\s/.test(ch);

/** A URL the renderer autolinks: markers inside it belong to the address, not to emphasis. */
const URL_STICKY = /(?:https?:\/\/|www\.)\S+/uy;

/**
 * Length of the autolinked URL starting at `index` (0 when none does). A sticky match: no slice, so
 * asking at every `h` of a long line costs the match and nothing more.
 */
export function urlLengthAt(text: string, index: number): number {
  URL_STICKY.lastIndex = index;
  const match = URL_STICKY.exec(text);
  return match ? match[0].length : 0;
}

/** True when a URL may start at `index`: line start, whitespace or an opening parenthesis before. */
export function urlMayStartAt(text: string, index: number): boolean {
  return index === 0 || /[\s(]/.test(text[index - 1]);
}
