/**
 * WHAT A FORMATTED SHORT ANSWER MAY SAY - the one judgement the fill page makes before sending and
 * the server makes before storing.
 *
 * Owner decision 2026-11-21 (G-VALID, 1.8.0), on a read-only survey of production: of 419 short
 * answers, 18% were a bare 1-3 digit number, 6 looked like a phone number, and 18 were "oui", "non"
 * or "x" typed by hand - a free text box standing in for a number, a phone, a choice. A short text
 * question may now carry a FORMAT: a number (whole by default, decimals on request, optional bounds),
 * a phone number, or an e-mail.
 *
 * THIS FILE IS COPIED, BYTE FOR BYTE, between the frontend and social-service, declared in
 * `.github/scripts/lib/declared-duplicates.mjs` (the same arrangement as `answer-text.ts`): "may
 * this text be sent" must have one answer on both sides, and the SERVER'S is authoritative - it
 * re-judges what the page already judged. It imports nothing.
 *
 * A valid answer is returned NORMALISED, and that is what is stored: a number as its canonical text
 * (`3,50` -> `3.5`, so a spreadsheet reads it as a number), a phone or an e-mail trimmed. Stored as a
 * string like every short answer, so no reader of a short answer changes.
 */

/** The formats a short text question may carry; absent (or `text`) is a free answer. */
export const ANSWER_FORMATS = ['number', 'phone', 'email'] as const;

/** One of {@link ANSWER_FORMATS}. */
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

/** The part of a question this judgement reads. */
export interface AnswerFormatRule {
  format?: string | null;
  /** A number's lower bound, inclusive; absent: none. */
  min?: number | null;
  /** A number's upper bound, inclusive; absent: none. */
  max?: number | null;
  /** A number may carry decimals; absent or false: whole numbers only. */
  allowDecimals?: boolean | null;
}

/** Why an answer was refused - the discriminator the page words, never an English sentence. */
export type AnswerFormatProblem =
  | 'not_a_number'
  | 'not_an_integer'
  | 'below_min'
  | 'above_max'
  | 'not_a_phone'
  | 'not_an_email';

/** The outcome of judging one answer: the text to store, or the problem. */
export type AnswerFormatVerdict =
  | { ok: true; value: string }
  | { ok: false; problem: AnswerFormatProblem };

/** The digits one number may hold: past it a double no longer reads back as typed. */
const NUMBER_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const EMAIL_MAX_LENGTH = 254;

/** Whether a question carries a format this build judges. */
export function hasAnswerFormat(rule: AnswerFormatRule): boolean {
  return (ANSWER_FORMATS as readonly string[]).includes(rule.format ?? '');
}

/** A number as typed: an optional minus, digits, and a `.` or `,` decimal part. */
function judgeNumber(rule: AnswerFormatRule, text: string): AnswerFormatVerdict {
  const typed = text.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(typed) || typed.replace(/\D/g, '').length > NUMBER_MAX_DIGITS) {
    return { ok: false, problem: 'not_a_number' };
  }
  if (!rule.allowDecimals && typed.includes('.')) return { ok: false, problem: 'not_an_integer' };
  const value = Number(typed);
  if (typeof rule.min === 'number' && value < rule.min) return { ok: false, problem: 'below_min' };
  if (typeof rule.max === 'number' && value > rule.max) return { ok: false, problem: 'above_max' };
  // `-0` reads as `0`: nobody typed a negative zero on purpose.
  return { ok: true, value: String(value === 0 ? 0 : value) };
}

/** A phone number: an optional `+`, then 7 to 15 digits, with spaces, dots, dashes, brackets between. */
function judgePhone(text: string): AnswerFormatVerdict {
  if (!/^\+?[\d\s.\-()]+$/.test(text)) return { ok: false, problem: 'not_a_phone' };
  const digits = text.replace(/\D/g, '').length;
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) {
    return { ok: false, problem: 'not_a_phone' };
  }
  return { ok: true, value: text };
}

/** An e-mail, judged for its shape only (one `@`, a dotted domain): the page cannot know more. */
function judgeEmail(text: string): AnswerFormatVerdict {
  if (
    text.length > EMAIL_MAX_LENGTH ||
    !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(text)
  ) {
    return { ok: false, problem: 'not_an_email' };
  }
  return { ok: true, value: text };
}

/**
 * Judges one short answer against its question's format. An empty answer is NOT judged here (an
 * optional question left blank is the absence, a required one is refused as missing); the caller
 * asks only when something was typed. A question with no format accepts the text as it is.
 */
export function judgeAnswerFormat(rule: AnswerFormatRule, raw: unknown): AnswerFormatVerdict {
  const text = String(raw ?? '').trim();
  switch (rule.format as AnswerFormat | undefined) {
    case 'number':
      return judgeNumber(rule, text);
    case 'phone':
      return judgePhone(text);
    case 'email':
      return judgeEmail(text);
    default:
      return { ok: true, value: text };
  }
}
