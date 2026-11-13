import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AudienceCondition } from '../pricing/audience';
import { pricedQuestionIds, type PriceMatrix } from '../pricing/price-matrix';
import {
  FORM_ANSWER_EDIT_OFF,
  FORM_ANSWER_LOCKED,
  FORM_ANSWER_NOT_EDITABLE,
  FORM_ANSWER_NOT_FOUND,
} from './answer-bounds';
import { decidesPrice, type PricedItem } from './answer-options';
import { isProductGridItem } from './product-grid';
import { normaliseCondition, type ConditionalItem } from './visibility';

/**
 * A RESPONDENT CHANGES THEIR OWN ANSWER (owner, 2026-11-13; migration 166) - the rules that are pure.
 *
 * `FormsService.editAnswer` runs the submit's own checks over the changed answer; what is here is
 * the part an edit adds: WHICH questions it may not touch, and how "the same answer" is judged.
 *
 * THE PRICE IS NEVER MOVED BY AN EDIT, whatever the answer's status. No top-up and no partial refund
 * exist, so every question whose answer can change what is charged is LOCKED from the moment the
 * answer is sent - paid, waiting for its money (online or cash) or free alike (the owner preferred
 * "locked once a payment request exists"; this is stricter on a FREE answer to a priced form, and
 * deliberately: re-pricing it would read today's profile and grid, and an edit from a 0 EUR cell to a
 * paid one would be a top-up). An edit therefore never re-prices, never writes `totalPaid`, `lines`
 * or a status, and never reaches the payment provider. See forms.md, "A respondent changes their own
 * answer".
 */

export {
  FORM_ANSWER_EDIT_OFF,
  FORM_ANSWER_LOCKED,
  FORM_ANSWER_NOT_EDITABLE,
  FORM_ANSWER_NOT_FOUND,
};

/** The subset of a form the lock rule reads. */
export interface EditLockForm {
  items: readonly (PricedItem & ConditionalItem)[] | null | undefined;
  priceMatrix: PriceMatrix | null | undefined;
  grantsCotisation: boolean;
  submitCondition: AudienceCondition | null | undefined;
}

/** What a stored answer itself says about how it was priced - read without any schema of its own. */
export interface EditLockRow {
  /** When the answer's cotisation was granted; null while it was not. */
  cotisationGrantedAt: Date | null;
  /** The priced grid lines AS CHARGED (migration 137): each names the question it priced. */
  lines: readonly { itemId: string }[] | null;
}

/**
 * The questions an edit may NOT change, by id - the price-affecting ones:
 *
 * - a priced grid (`product_grid`): its quantities are the order;
 * - a question the price grid divides on (an `answer` criterion of `priceMatrix`);
 * - a choice question with an option supplement (`decidesPrice`);
 * - and, CLOSED UNDER VISIBILITY, every question whose answer decides whether one of those is shown
 *   (`showIf.answer`, or the legacy `dependsOn`): hiding a priced question drops its supplement or
 *   moves the person to the "everyone else" cell, which is a price change made one question away.
 *
 * `grantMade` (the lead's reversible decision of 2026-11-13): once the answer's cotisation was
 * GRANTED, the question that decided whether the person could answer at all - the ANSWER criterion
 * of `submitCondition` on a form that grants - is locked too, like a price. No question chooses the
 * tier itself today (the tier is the form's, `cotisationVariantKey`), and every granting form charges,
 * so its priced questions are locked already.
 *
 * `pricedOnRow` (the lead's reversible decision of 2026-11-13, no schema change): the questions the
 * ROW itself says it was priced on - every `itemId` of its stored `lines` - are locked whatever the
 * form says TODAY, so a grid a manager later unpriced or retyped still holds on the rows charged with
 * it. The closure below then runs over them too.
 */
export function editLockedItemIds(
  form: EditLockForm,
  grantMade: boolean,
  pricedOnRow: Iterable<string> = []
): Set<string> {
  const items = form.items ?? [];
  const gridQuestions = pricedQuestionIds(form.priceMatrix);
  const locked = new Set<string>();
  for (const item of items) {
    if (isProductGridItem(item) || decidesPrice(item, gridQuestions)) locked.add(item.id);
  }
  const admission = form.submitCondition?.answer?.questionId;
  if (grantMade && form.grantsCotisation && admission) locked.add(admission);
  for (const itemId of pricedOnRow) locked.add(itemId);

  // The closure: a question that shows or hides a locked one is locked in its turn.
  const byId = new Map(items.map((item) => [item.id, item]));
  const frontier = [...locked];
  while (frontier.length > 0) {
    const item = byId.get(frontier.pop()!);
    const parent = item ? normaliseCondition(item)?.answer?.questionId : undefined;
    if (parent && byId.has(parent) && !locked.has(parent)) {
      locked.add(parent);
      frontier.push(parent);
    }
  }
  return locked;
}

/**
 * The locked questions of ONE stored answer: today's rule over the form, united with what the row
 * itself recorded of its price (`lines`) and its grant (`cotisationGrantedAt`). The one call every
 * reader of the lock makes - the list the fill page draws, the judgement, and the write's re-check.
 */
export function rowLockedItemIds(form: EditLockForm, row: EditLockRow): Set<string> {
  return editLockedItemIds(
    form,
    row.cotisationGrantedAt != null,
    (row.lines ?? []).map((line) => line.itemId)
  );
}

/**
 * One answer value in a canonical spelling, or `null` for "no answer": absent, `''`, `[]`, a map
 * with no entry left. A multiple choice is a SET (the order ticked is not the answer), and inside a
 * map an empty row or a zero quantity is no entry - what a grid stores without. A top-level number
 * keeps its zero: a scale answered 0 is an answer.
 */
function canonical(value: unknown, nested = false): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return JSON.stringify(value.map((v) => String(v)).sort());
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => [key, canonical(v, true)] as const)
      .filter(([, v]) => v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length === 0 ? null : JSON.stringify(entries);
  }
  if (nested && value === 0) return null;
  return JSON.stringify(value);
}

/** Whether two answer values say the same thing (`canonical`): the test a locked answer must pass. */
export function sameAnswer(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The refusal of an edit on a form whose answers cannot be changed. */
export function answerEditOff(): ForbiddenException {
  return new ForbiddenException({
    code: FORM_ANSWER_EDIT_OFF,
    message: 'The answers to this form cannot be changed.',
  });
}

/** The refusal of an edit changing a price-affecting question, naming it. */
export function answerLocked(itemId: string): ConflictException {
  return new ConflictException({
    code: FORM_ANSWER_LOCKED,
    message: 'This question decides the price and cannot be changed once the answer is sent.',
    itemId,
  });
}

/** The refusal of an edit of a row that is no longer an answer. */
export function answerNotEditable(): ConflictException {
  return new ConflictException({
    code: FORM_ANSWER_NOT_EDITABLE,
    message: 'This answer was cancelled or has expired: there is nothing left to change.',
  });
}

/**
 * The refusal of an edit naming no answer of the caller's. ONE answer for "no such row" and "another
 * person's row", as every respondent read of a form answers an id it will not serve (404): the
 * caller learns nothing about an answer that is not theirs.
 */
export function answerNotFound(): NotFoundException {
  return new NotFoundException({ code: FORM_ANSWER_NOT_FOUND, message: 'Answer not found.' });
}
