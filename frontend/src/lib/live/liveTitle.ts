/**
 * A LIVE'S TITLE, CLIENT SIDE (owner, 2026-11-07): optional, at most the server's `titleMaxChars`
 * characters, entered on the launch screen and editable on air. The server's rule
 * (`parseLiveTitle` in social-service) is the authority; this mirrors it so the field never offers
 * what the server would refuse:
 *
 * - trimmed; blank is "no title" (`null`);
 * - CHARACTERS are code points - an emoji is one, as PostgreSQL's `char_length` counts it - never
 *   UTF-16 units (an `<input maxlength>` counts those, so it would refuse half the emoji the server
 *   takes);
 * - one line: a line break or any control character is removed as it is typed.
 */

/** How many characters a title holds, as the server counts them (code points). */
export function liveTitleLength(text: string): number {
  return [...text].length;
}

/**
 * What the field holds after a keystroke: control characters (a pasted line break included)
 * become spaces, and the text is cut at `maxChars` characters - never in the middle of a character.
 */
export function clampLiveTitleInput(raw: string, maxChars: number): string {
  const oneLine = raw.replace(/\p{Cc}/gu, ' ');
  const chars = [...oneLine];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : oneLine;
}

/** The title to send: trimmed, blank as `null`. */
export function liveTitleToSend(draft: string): string | null {
  const title = draft.trim();
  return title === '' ? null : title;
}
