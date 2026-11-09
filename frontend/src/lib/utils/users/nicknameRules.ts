/**
 * THE LIMITS OF A PER-CONVERSATION NICKNAME, the client's half of
 * `libs/contracts/conversation-nickname.json` (social-service holds the other half, and each side's
 * spec walks the contract's cases).
 *
 * Mirrors the profile's name fields, as the owner decided (2026-10-14): NFKC, every control and
 * format character dropped (a zero-width space or a bidi override would let a nickname impersonate
 * another member's name), trimmed, at most {@link NICKNAME_MAX_LENGTH} code points. A value empty
 * once normalized is a RESET - no nickname - never an empty label.
 *
 * Run on the way OUT (the screen, before a frame is queued or a request sent) and on the way IN
 * (every MLS frame and bundle entry): an MLS group has no server to refuse a malformed value, so a
 * peer's frame is held to the same rule by every reader.
 */

/** Longest nickname, in code points - the profile form's `maxlength`, and PostgreSQL's unit. */
export const NICKNAME_MAX_LENGTH = 100;

/** The typed refusal of a nickname longer than {@link NICKNAME_MAX_LENGTH}. */
export const NICKNAME_TOO_LONG = 'nickname_too_long';

/** A normalized nickname (`null` = reset), or the refusal of one that is too long. */
export type NicknameNormalization =
  | { ok: true; value: string | null }
  | { ok: false; code: typeof NICKNAME_TOO_LONG };

/**
 * Drops every control, invisible-formatting, line and paragraph separator character
 * (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`) - a zero-width space or a bidi override would let a nickname
 * impersonate another member's name - EXCEPT the two kinds that are writing, not hiding:
 *
 *  - the glue of an emoji, judged per grapheme as #3175's role labels are: inside a grapheme that
 *    holds a pictographic (or starts with U+1F3F4, a tag flag), the zero-width joiner U+200D and the
 *    tag characters U+E0020-U+E007F stay (a family, a profession, the rainbow or the England flag);
 *  - a zero-width non-joiner or joiner (U+200C, U+200D) BETWEEN two letters or marks, which Persian
 *    and the Indic scripts need to spell a word.
 */
function stripInvisible(value: string): string {
  const forbidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const emojiGlue = /[‍\u{E0020}-\u{E007F}]/u;
  const letter = /[\p{L}\p{M}]/u;
  const points = [...value];
  // Which code points sit in an emoji grapheme, walked once.
  const inEmoji: boolean[] = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    value
  )) {
    const isEmoji = /\p{Extended_Pictographic}/u.test(segment) || segment.startsWith('\u{1F3F4}');
    for (let i = [...segment].length; i > 0; i--) inEmoji.push(isEmoji);
  }
  let out = '';
  points.forEach((point, i) => {
    if (!forbidden.test(point)) out += point;
    else if (inEmoji[i] && emojiGlue.test(point)) out += point;
    else if (
      (point === '‌' || point === '‍') &&
      letter.test(points[i - 1] ?? '') &&
      letter.test(points[i + 1] ?? '')
    ) {
      out += point;
    }
  });
  return out;
}

/** Normalizes a raw nickname by the contract's rule - see the module comment. */
export function normalizeNickname(raw: string | null | undefined): NicknameNormalization {
  if (typeof raw !== 'string') return { ok: true, value: null };
  const value = stripInvisible(raw.normalize('NFKC')).trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, code: NICKNAME_TOO_LONG };
  return { ok: true, value };
}
