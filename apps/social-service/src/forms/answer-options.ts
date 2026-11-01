import { BadRequestException } from '@nestjs/common';
import { OTHERS_BUCKET_ID, type Dimension } from '../pricing/audience';
import { allCellKeys, pricedQuestionIds, type PriceMatrix } from '../pricing/price-matrix';
import { normaliseCondition, type ConditionalItem } from './visibility';

/**
 * WHAT A PRICED ANSWER MAY SAY, AND WHICH PRICE A GRID MAY NOT FALL BACK TO.
 *
 * A choice answer is a list of option ids typed by the client. Where the answer decides a price - a
 * question the grid prices on, or one whose options carry a supplement - an id the question never
 * declared would not match any group nor any supplement, and the answer would land on the grid's
 * "everyone else" cell or on no supplement at all, while the stored answer still reads as the
 * choice. So such an answer is refused unless every id it names is one of the question's options.
 *
 * The same rule holds for a member and a guest: it is read by `submit` for both.
 */

/** The question types whose answer is option ids: one id, or a list of them. */
const SINGLE_CHOICE_TYPES = new Set(['single_choice', 'dropdown']);
const MULTIPLE_CHOICE_TYPE = 'multiple_choice';

/** The subset of a stored item these checks read. */
export interface PricedItem extends ConditionalItem {
  type?: string;
  label?: string;
  required?: boolean;
  options?: { id?: string; priceModifier?: number }[] | null;
}

/**
 * Whether an answer to this question can change what is charged: the grid prices on it, or it is a
 * CHOICE question with an option supplement. The type decides, not the stored modifiers: a question
 * turned into a matrix keeps its old options' modifiers, and its answer (an object) never charged.
 */
export function decidesPrice(item: PricedItem, gridQuestions: Set<string>): boolean {
  if (gridQuestions.has(item.id)) return true;
  return isChoiceQuestion(item) && (item.options ?? []).some((o) => (o.priceModifier ?? 0) > 0);
}

/**
 * Whether a question's option SUPPLEMENTS apply: only a CHOICE question's. The DTO accepts `options`
 * on any question type, so the type - not the presence of options - is the rule, and it is the ONE
 * rule at save (`decidesPrice`, the kind guard's fingerprint) and at submit (`calculateModifiers`'
 * caller): a text question carrying a priced option charges nothing, anywhere.
 */
export function isChoiceQuestion(item: { type?: string }): boolean {
  return SINGLE_CHOICE_TYPES.has(item.type ?? '') || item.type === MULTIPLE_CHOICE_TYPE;
}

/** The subset of an item the duplicate-id check reads. */
interface IdentifiedItem {
  id?: string;
  label?: string;
}

/**
 * Refuses two questions with one id, naming both so the organiser can fix them. Every reader of a
 * form resolves a question by its id, and two readers resolving a duplicate differently (the first,
 * or the last) would judge one question and price another.
 *
 * On an edit, pass the STORED items: a duplicate already stored never blocks an edit that leaves the
 * questions' ids as they are. The edit page resends the whole list on every save - a title, a
 * deadline, closing the form - converted for the API (`itemsPayload.ts`), so the list sent is never
 * byte-equal to the stored one; its ID SEQUENCE is. Only a list whose ids differ from the stored ones
 * (a question added, removed, reordered or re-identified) is held to the rule.
 */
export function assertUniqueItemIds(
  items: readonly IdentifiedItem[] | null | undefined,
  stored?: readonly IdentifiedItem[] | null
): void {
  const list = items ?? [];
  if (stored && sameIdSequence(list, stored)) return;
  const firstAt = new Map<string, number>();
  list.forEach((item, index) => {
    if (!item.id) return;
    const first = firstAt.get(item.id);
    if (first === undefined) {
      firstAt.set(item.id, index);
      return;
    }
    throw new BadRequestException(
      `Questions ${first + 1} ("${list[first].label ?? ''}") and ${index + 1} ` +
        `("${item.label ?? ''}") share the id ${item.id}; each needs its own.`
    );
  });
}

/** Whether two question lists carry the same ids, in the same order. */
function sameIdSequence(a: readonly IdentifiedItem[], b: readonly IdentifiedItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i].id);
}

/** Whether a value is "no answer": what the fill page sends for a choice left empty. */
function isEmptyChoice(value: unknown): boolean {
  return (
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  );
}

/**
 * Refuses a VISIBLE question's answer that decides a price and names anything but the question's
 * own options: an unknown id, a duplicate, a list where one choice is asked, a number. A question
 * the submitter does not see is not judged here - it is neither priced nor stored (`submit`).
 */
export function assertDeclaredOptionAnswers(
  items: readonly PricedItem[],
  answers: Record<string, unknown>,
  visible: ReadonlySet<string>,
  matrix: PriceMatrix | null | undefined
): void {
  const gridQuestions = pricedQuestionIds(matrix);
  for (const item of items) {
    if (!visible.has(item.id) || !decidesPrice(item, gridQuestions)) continue;
    const value = answers[item.id];
    if (isEmptyChoice(value)) continue;
    const declared = new Set((item.options ?? []).map((o) => o.id).filter(Boolean));
    const chosen: unknown[] | null = SINGLE_CHOICE_TYPES.has(item.type ?? '')
      ? typeof value === 'string'
        ? [value]
        : null
      : item.type === MULTIPLE_CHOICE_TYPE && Array.isArray(value)
        ? value
        : null;
    const valid =
      chosen !== null &&
      new Set(chosen).size === chosen.length &&
      chosen.every((id) => typeof id === 'string' && declared.has(id));
    if (!valid) {
      throw new BadRequestException(
        `Answer for field ${item.label ?? item.id} is not one of its options.`
      );
    }
  }
}

/**
 * Whether a grid dimension's "everyone else" group can be reached by a submitter: its question may
 * be left empty (not required), hidden (it has a condition), answered with an option no group
 * holds, or is not a choice question at all. A required, unconditional choice question whose every
 * option sits in a group never lands there.
 */
function othersReachable(dimension: Dimension, items: readonly PricedItem[]): boolean {
  if (dimension.kind !== 'answer') return true;
  const item = items.find((i) => i.id === dimension.questionId);
  if (!item || !item.required || normaliseCondition(item) !== null) return true;
  if (!SINGLE_CHOICE_TYPES.has(item.type ?? '') && item.type !== MULTIPLE_CHOICE_TYPE) return true;
  const grouped = new Set(dimension.buckets.flatMap((b) => b.values));
  return (item.options ?? []).some((o) => !o.id || !grouped.has(o.id));
}

/**
 * The cells of a CHARGING grid a submitter can reach through an "everyone else" group and that
 * price at 0 - the free seat a public form must not offer by default (decision PP1, WP-P1). A grid
 * that charges nobody is a free form and returns none. The manager prices such a cell, or marks it
 * unavailable.
 */
export function freeFallbackCells(
  matrix: PriceMatrix | null | undefined,
  items: readonly PricedItem[]
): string[] {
  if (!matrix) return [];
  if (!Object.values(matrix.cells).some((v) => typeof v === 'number' && v > 0)) return [];
  const reachable = matrix.dimensions.map((d) => othersReachable(d, items));
  return allCellKeys(matrix.dimensions).filter((key) => {
    if (matrix.cells[key] !== 0) return false;
    const parts = key.split('|');
    const viaOthers = parts.some((p) => p === OTHERS_BUCKET_ID);
    return viaOthers && parts.every((p, i) => p !== OTHERS_BUCKET_ID || reachable[i]);
  });
}
