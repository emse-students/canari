// `Intl.Segmenter` is ES2022; social-service compiles for es2021 and runs on a runtime that has it.
/// <reference lib="es2022.intl" />
/**
 * WHAT A NAME MAY HOLD, written once and kept byte for byte in TWO copies - the client's
 * (`frontend/src/lib/utils/users/visibleText.ts`) and the server's
 * (`apps/social-service/src/channels/visible-text.ts`), declared in
 * `.github/scripts/lib/declared-duplicates.mjs`. It takes plain strings and imports nothing, which is
 * what lets the copies be identical.
 *
 * Two rules read it:
 *  - a per-conversation NICKNAME (`normalizeNickname`), whose cases are
 *    `libs/contracts/conversation-nickname.json`, walked by both sides' specs;
 *  - a community ROLE's display name (`hasInvisibleCharacter`, #3175), refused when it holds what
 *    a nickname would have stripped.
 */

/** Longest nickname, in code points - the profile form's `maxlength`, and migration 149's `varchar(100)`. */
export const NICKNAME_MAX_LENGTH = 100;

/** The typed refusal (400 `code` on the server) of a nickname longer than {@link NICKNAME_MAX_LENGTH}. */
export const NICKNAME_TOO_LONG = 'nickname_too_long';

/** A normalized nickname (`null` = reset), or the refusal of one that is too long. */
export type NicknameNormalization =
  | { ok: true; value: string | null }
  | { ok: false; code: typeof NICKNAME_TOO_LONG };

/**
 * Drops every control, invisible-formatting, line and paragraph separator character
 * (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`) - a zero-width space or a bidi override would let a name impersonate
 * another - EXCEPT what is writing, not hiding, judged per grapheme:
 *
 *  - the zero-width joiner U+200D INSIDE an emoji grapheme (one holding a pictographic), never as
 *    its last code point - a family or a profession, not an emoji with a joiner left dangling;
 *  - the tag characters U+E0020-U+E007F only in a TAG FLAG: a grapheme that starts with U+1F3F4 and
 *    ends with the cancel tag U+E007F (the England flag), never trailing after any other emoji;
 *  - a zero-width non-joiner or joiner (U+200C, U+200D) between two letters or marks OF A SCRIPT THAT
 *    SPELLS WITH THEM - Arabic (Persian), Syriac and the Indic scripts - never between two Latin,
 *    Greek or Cyrillic letters, where it only splits a name that looks whole.
 */
export function stripInvisible(value: string): string {
  const forbidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const zwnj = '‌';
  const zwj = '‍';
  const tag = /[\u{E0020}-\u{E007F}]/u;
  const joiningLetter =
    /^(?=[\p{L}\p{M}])[\p{scx=Arabic}\p{scx=Syriac}\p{scx=Devanagari}\p{scx=Bengali}\p{scx=Gurmukhi}\p{scx=Gujarati}\p{scx=Oriya}\p{scx=Tamil}\p{scx=Telugu}\p{scx=Kannada}\p{scx=Malayalam}\p{scx=Sinhala}]$/u;
  let out = '';
  for (const { segment, index } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(value)) {
    const points = [...segment];
    const pictographic = /\p{Extended_Pictographic}/u.test(segment);
    const tagFlag = points[0] === '\u{1F3F4}' && points[points.length - 1] === '\u{E007F}';
    points.forEach((point, i) => {
      if (!forbidden.test(point)) out += point;
      else if (tag.test(point) && tagFlag) out += point;
      else if (point === zwj && pictographic && i < points.length - 1) out += point;
      else if (point === zwnj || point === zwj) {
        // Between graphemes: the letters on either side are the last one written and the next one.
        const before = [...out].pop() ?? '';
        const next = value.codePointAt(index + segment.length);
        const after = points[i + 1] ?? (next === undefined ? '' : String.fromCodePoint(next));
        if (joiningLetter.test(before) && joiningLetter.test(after)) out += point;
      }
    });
  }
  return out;
}

/** Whether `value` holds a character {@link stripInvisible} would drop - a role name's refusal. */
export function hasInvisibleCharacter(value: string): boolean {
  return stripInvisible(value) !== value;
}

/**
 * Normalizes a raw nickname: NFKC, {@link stripInvisible}, trimmed; empty once normalized is a RESET
 * (`null`), never an empty label; at most {@link NICKNAME_MAX_LENGTH} code points. Anything that is
 * not a string is a reset too.
 */
export function normalizeNickname(raw: unknown): NicknameNormalization {
  if (typeof raw !== 'string') return { ok: true, value: null };
  const value = stripInvisible(raw.normalize('NFKC')).trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, code: NICKNAME_TOO_LONG };
  return { ok: true, value };
}
