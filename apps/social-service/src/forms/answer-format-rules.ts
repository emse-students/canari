import { BadRequestException, Logger } from '@nestjs/common';
import {
  hasAnswerFormat,
  judgeAnswerFormat,
  type AnswerFormatProblem,
  type AnswerFormatRule,
} from './answer-format';
import { FORM_ANSWER_FORMAT_INVALID, FORM_FORMAT_RANGE_INVALID } from './answer-bounds';

/**
 * THE SERVER'S SIDE OF A SHORT QUESTION'S FORMAT (`answer-format.ts` holds the judgement both sides
 * share): what a save may declare, what a submit stores, and the empty answers it no longer stores.
 * Owner decision 2026-11-21 (G-VALID, 1.8.0); the mechanism is in `docs/wiki/frontend/modules/forms.md`.
 */

const logger = new Logger('AnswerFormats');

/** The part of a stored question these read. */
interface FormattedItem extends AnswerFormatRule {
  id?: string;
  type?: string;
}

/**
 * The 400 refusing an answer that does not fit its question's format. `problem` is the discriminator
 * the page words (never this sentence); `min` and `max` ride along so a range can be said with its
 * numbers. Carries the `itemId`, so the page marks the question.
 */
export function answerFormatRefusal(
  item: FormattedItem,
  problem: AnswerFormatProblem
): BadRequestException {
  return new BadRequestException({
    code: FORM_ANSWER_FORMAT_INVALID,
    message: `Answer for field ${item.id} does not fit its format (${problem}).`,
    itemId: item.id,
    problem,
    ...(typeof item.min === 'number' ? { min: item.min } : {}),
    ...(typeof item.max === 'number' ? { max: item.max } : {}),
  });
}

/**
 * The questions as a save will store them: a format belongs to a SHORT TEXT question, and a number's
 * bounds and decimals to a `number` format. Anything else is dropped and logged - the editor cannot
 * draw it, so it is a question turned into another type, or a hand-made call. A range whose minimum
 * is above its maximum is refused (`FORM_FORMAT_RANGE_INVALID`): no answer could ever satisfy it.
 */
export function normaliseAnswerFormats<T extends FormattedItem>(
  items: readonly T[] | undefined
): T[] {
  return (items ?? []).map((item) => {
    if (item.format == null && item.min == null && item.max == null && item.allowDecimals == null) {
      return item;
    }
    const { format, min, max, allowDecimals, ...rest } = item;
    const formatted = item.type === 'short_text' && hasAnswerFormat(item);
    if (!formatted) {
      logger.warn(`[ANSWER_FORMAT] save: format settings dropped from question ${item.id}`);
      return rest as unknown as T;
    }
    if (format !== 'number') {
      return { ...rest, format } as unknown as T;
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new BadRequestException({
        code: FORM_FORMAT_RANGE_INVALID,
        message: `Question ${item.id}: the minimum ${min} is above the maximum ${max}.`,
        itemId: item.id,
      });
    }
    return {
      ...rest,
      format,
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
      allowDecimals: allowDecimals === true,
    } as unknown as T;
  });
}

/**
 * `answers` with every VISIBLE formatted question's answer judged and replaced by its normalised
 * text; an answer that does not fit is the typed refusal ({@link answerFormatRefusal}). An empty
 * answer is not judged - it is the absence ({@link dropEmptyAnswers}), and a required question is
 * refused as missing by the submit's own rule. A question the submitter cannot see is not judged.
 */
export function settleAnswerFormats(
  items: readonly FormattedItem[],
  answers: Record<string, unknown>,
  visible: ReadonlySet<string>
): Record<string, unknown> {
  const out = { ...answers };
  for (const item of items) {
    if (!item.id || item.type !== 'short_text' || !hasAnswerFormat(item)) continue;
    if (!visible.has(item.id)) continue;
    const raw = out[item.id];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const verdict = judgeAnswerFormat(item, raw);
    if ('problem' in verdict) {
      logger.log(`[ANSWER_FORMAT] answer to ${item.id} refused: ${verdict.problem}`);
      throw answerFormatRefusal(item, verdict.problem);
    }
    out[item.id] = verdict.value;
  }
  return out;
}

/**
 * `answers` without the entries that say nothing: `''`, `null`, an empty list. A skipped optional
 * question is STORED AS ABSENT, not as `""` (owner, 2026-11-21: 93 of 419 short answers in
 * production were an empty string) - every reader of an answer already treats the two alike
 * (`isQuestionAnswered`, `canonical` in `answer-edit.ts`, `answerText`, the responses table and the
 * export), so rows already stored with `""` stay readable and nothing is rewritten.
 */
export function dropEmptyAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).filter(
      ([, value]) =>
        !(value === '' || value === null || (Array.isArray(value) && value.length === 0))
    )
  );
}
