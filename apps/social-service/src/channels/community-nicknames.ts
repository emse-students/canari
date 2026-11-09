// `Intl.Segmenter` is ES2022; the service compiles for es2021 and runs on a runtime that has it.
/// <reference lib="es2022.intl" />
/**
 * THE LIMITS OF A COMMUNITY NICKNAME, the server's half of `libs/contracts/conversation-nickname.json`
 * (the frontend's `nicknameRules.ts` is the other; each side's spec walks the contract's cases).
 *
 * Mirrors the profile's name fields (owner, 2026-10-14): NFKC, control and format characters dropped,
 * trimmed, at most {@link NICKNAME_MAX_LENGTH} code points - the unit `varchar(100)` counts. A value
 * empty once normalized is a RESET, never an empty nickname.
 */

/** Longest nickname, in code points (migration 149's `varchar(100)`). */
export const NICKNAME_MAX_LENGTH = 100;

/** 400 `code`: the nickname is longer than {@link NICKNAME_MAX_LENGTH} once normalized. */
export const NICKNAME_TOO_LONG = 'nickname_too_long';

/** 403 `code`: only a moderator names somebody in a community; a member may only clear their own. */
export const NICKNAME_REQUIRES_MODERATION = 'NICKNAME_REQUIRES_MODERATION';

/** 404 `code`: the person named is not a member of this community. */
export const NICKNAME_TARGET_NOT_MEMBER = 'NICKNAME_TARGET_NOT_MEMBER';

/** A normalized nickname (`null` = reset), or the refusal of one that is too long. */
export type NicknameNormalization =
  | { ok: true; value: string | null }
  | { ok: false; code: typeof NICKNAME_TOO_LONG };

/**
 * Drops every control, invisible-formatting, line and paragraph separator character
 * (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`) - a zero-width space or a bidi override would let a nickname
 * impersonate another member's name - EXCEPT what is writing, not hiding, judged per grapheme as
 * #3175's role labels are (and narrowed by the review of #3177):
 *
 *  - the zero-width joiner U+200D INSIDE an emoji grapheme (one holding a pictographic), never as
 *    its last code point - a family or a profession, not an emoji with a joiner left dangling;
 *  - the tag characters U+E0020-U+E007F only in a TAG FLAG: a grapheme that starts with U+1F3F4 and
 *    ends with the cancel tag U+E007F (the England flag), never trailing after any other emoji;
 *  - a zero-width non-joiner or joiner (U+200C, U+200D) between two letters or marks OF A SCRIPT THAT
 *    SPELLS WITH THEM - Arabic (Persian), Syriac and the Indic scripts - never between two Latin,
 *    Greek or Cyrillic letters, where it only splits a name that looks whole.
 */
function stripInvisible(value: string): string {
  const forbidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const zwnj = '\u200C';
  const zwj = '\u200D';
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

/** Normalizes a raw nickname by the contract's rule - see the module comment. */
export function normalizeNickname(raw: unknown): NicknameNormalization {
  if (typeof raw !== 'string') return { ok: true, value: null };
  const value = stripInvisible(raw.normalize('NFKC')).trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, code: NICKNAME_TOO_LONG };
  return { ok: true, value };
}

/**
 * Who may write `target`'s nickname in a community - THE ONLY definition (owner, 2026-10-14 and
 * 2026-10-18): a moderator (`roleGrantsModeration`, the grant the client is handed as
 * `viewerCanModerate`) names anybody; the person named may always CLEAR their own, moderator or not.
 */
export function mayWriteCommunityNickname(input: {
  actorIsTarget: boolean;
  isReset: boolean;
  actorCanModerate: boolean;
}): boolean {
  if (input.actorCanModerate) return true;
  return input.actorIsTarget && input.isReset;
}

/**
 * A REPORT NAMES ONE VERSION OF A NICKNAME: `<member row id>@<set-at ms>`. A report is filed once per
 * reporter per subject (`content_reports_reporter_content_uniq`), so naming the member row alone would
 * let one report of a first insult forbid reporting the next one set on the same person; and the
 * moderator reading it must see whether what was reported is still what is shown.
 */
export function nicknameReportSubject(memberRowId: string, setAtMs: number): string {
  return `${memberRowId}@${setAtMs}`;
}

/** The two halves of {@link nicknameReportSubject}, or null for a value that is not one. */
export function parseNicknameReportSubject(
  subject: string
): { memberRowId: string; setAtMs: number } | null {
  const match = /^([0-9a-f-]{36})@(\d{1,16})$/i.exec(subject);
  if (!match) return null;
  return { memberRowId: match[1].toLowerCase(), setAtMs: Number(match[2]) };
}
