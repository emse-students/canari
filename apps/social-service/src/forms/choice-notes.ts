import { Logger } from '@nestjs/common';
import { isChoiceQuestion } from './answer-options';
import { noteKeyOwner, otherKey, commentKey, type AnswerOption } from './answer-text';

/**
 * THE TWO FREE TEXTS OF A CHOICE QUESTION: its optional comment, and what is typed beside "Autre".
 *
 * A manager switches a comment on per question (`allowComment`) and may add ONE "Autre" option
 * (`options[].other`), and the answer then carries `<id>#comment` and `<id>#other` beside the
 * choice (`answer-text.ts` names the keys and reads them). Owner decision 2026-11-21, on a
 * read-only survey of production: a "Commentaire" long-text question placed after a yes/no was
 * answered 20-57% of the time, and one choice question in 42 offered an "Autre" - people write
 * what they mean when the form lets them, and a form that does not forces a second question.
 *
 * TWO RULES THAT ARE DECISIONS, NOT ACCIDENTS:
 * - The "Autre" text is ALLOWED, never required. A client built before this existed draws "Autre"
 *   as a plain option with no text box and could not satisfy a requirement, so making it
 *   mandatory would lock those clients out of the form (principle 2, the essential is never lost).
 * - Neither text is a question and neither is identity: they are free text of the same class as a
 *   long answer, stored in the answer's own record, so an anonymous form stays anonymous.
 *
 * Both sides of the write are judged here: the save normalises what a form may declare, and the
 * submit keeps only the texts that belong to a visible answer.
 */

const logger = new Logger('ChoiceNotes');

/** The part of a stored question this reads. */
interface NotedItem {
  id?: string;
  type?: string;
  allowComment?: boolean;
  options?: (AnswerOption & { priceModifier?: number })[] | null;
}

/**
 * The questions as a save will store them: `allowComment` and the `other` mark exist on CHOICE
 * questions only, and a question holds one "Autre". The editor cannot draw anything else, so a
 * payload that does (an old editor round-tripping a question turned into text, a hand-made call)
 * is normalised and the correction logged rather than refused - nothing the manager can act on.
 */
export function normaliseChoiceNotes<T extends NotedItem>(items: readonly T[] | undefined): T[] {
  return (items ?? []).map((item) => {
    const choice = isChoiceQuestion(item);
    let next = item;
    if (!choice && item.allowComment) {
      logger.warn(`[CHOICE_NOTES] save: comment dropped from non-choice question ${item.id}`);
      next = { ...next, allowComment: false };
    }
    const options = item.options;
    if (options?.some((option) => option.other)) {
      let seen = false;
      const kept = options.map((option) => {
        if (!option.other) return option;
        if (choice && !seen) {
          seen = true;
          return option;
        }
        logger.warn(
          `[CHOICE_NOTES] save: extra or misplaced "other" mark dropped on question ${item.id}`
        );
        const { other: _other, ...plain } = option;
        return plain;
      });
      next = { ...next, options: kept as T['options'] };
    }
    return next;
  });
}

/** The option ids a choice answer names, whatever its shape (one id or a list). */
function chosenIds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * `answers` with its comment and "Autre" texts judged against the form: kept - trimmed - only when
 * the question is visible, the comment is allowed on it, or the answer really picks its "Autre";
 * dropped and logged otherwise. A key that is itself a declared question id is an ordinary answer.
 *
 * A text of a question that is not declared at all is dropped too: the key family is new, so there
 * is no stored shape to keep (unlike an undeclared plain key, which has always been kept).
 */
export function settleAnswerNotes(
  items: readonly NotedItem[],
  answers: Record<string, unknown>,
  visible: ReadonlySet<string>
): Record<string, unknown> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    const owner = byId.has(key) ? null : noteKeyOwner(key);
    if (!owner) {
      out[key] = value;
      continue;
    }
    const item = byId.get(owner.itemId);
    const text = typeof value === 'string' ? value.trim() : '';
    const why = !item
      ? 'its question is not declared'
      : !visible.has(owner.itemId)
        ? 'its question is not visible'
        : text === ''
          ? 'it is empty'
          : owner.kind === 'comment'
            ? item.allowComment
              ? null
              : 'the question takes no comment'
            : picksOther(item, answers[owner.itemId])
              ? null
              : 'the answer does not pick "Autre"';
    if (why === null) {
      out[key] = text;
      continue;
    }
    logger.debug(`[CHOICE_NOTES] ${key} not stored: ${why}`);
  }
  return out;
}

/** Whether the answer names the question's "Autre" option. */
function picksOther(item: NotedItem, answer: unknown): boolean {
  if (!isChoiceQuestion(item)) return false;
  const otherIds = (item.options ?? []).filter((option) => option.other).map((option) => option.id);
  return chosenIds(answer).some((id) => otherIds.includes(id));
}

/** The record keys of one question's texts, for a caller that carries or drops them with it. */
export function noteKeysOf(itemId: string): { other: string; comment: string } {
  return { other: otherKey(itemId), comment: commentKey(itemId) };
}
