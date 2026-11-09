import { Log } from '$lib/utils/Log';
import { ensureMatrixAxes } from './matrixEditor';
import { PRODUCT_GRID_TYPE } from './productGridContract';
import { newProductGrid } from './productGridEditor';
import { isMatrixType } from './questionTypes';

/**
 * A NEW QUESTION, AND WHERE IT GOES - one factory for the add wizard and the card's type change.
 *
 * Before the wizard (owner, 2026-11-07) the section built a question inline from the type picked;
 * the wizard now fills that question in its second step and inserts it whole, after the card it
 * was opened from or at the end.
 */

/** A question in the builder: the stored fields, with the editor's ids on options and rows. */
export interface DraftQuestion {
  id: string;
  label: string;
  required: boolean;
  type: string;
  options: { id?: string; label: string; priceModifier?: number }[];
  rows: { id: string; value: string }[];
  [key: string]: unknown;
}

/**
 * A blank question of `type`. A priced grid is required (its order is the answer) and carries a
 * new definition; a scale runs from 1 to 5; a choice grid starts with one blank row and one blank column, so its table has
 * somewhere to type; every other type starts with one blank option (dropped on save when unused).
 */
export function newQuestion(type: string): DraftQuestion {
  const id = crypto.randomUUID();
  Log.d('questionDraft', `new ${type} question`);
  if (type === PRODUCT_GRID_TYPE) {
    return {
      id,
      label: '',
      required: true,
      type,
      options: [],
      rows: [],
      productGrid: newProductGrid(),
    };
  }
  const question: DraftQuestion = {
    id,
    label: '',
    required: false,
    type,
    options: isMatrixType(type) ? [] : [{ id: crypto.randomUUID(), label: '' }],
    rows: [],
  };
  if (isMatrixType(type)) ensureMatrixAxes(question);
  // A scale from 1 to 5, the card's own default for a stored question without one.
  if (type === 'linear_scale') question.scale = { min: 1, max: 5 };
  return question;
}

/**
 * `items` with `question` inserted right after `afterIndex`, or at the end when it is null (or out
 * of range). A new array: the list is a bound `$state`, and one assignment is one write.
 */
export function insertQuestion<T>(
  items: readonly T[],
  question: T,
  afterIndex: number | null
): T[] {
  const at =
    afterIndex === null || afterIndex < 0 || afterIndex >= items.length
      ? items.length
      : afterIndex + 1;
  Log.d('questionDraft', `inserting a question at ${at} of ${items.length}`);
  return [...items.slice(0, at), question, ...items.slice(at)];
}
