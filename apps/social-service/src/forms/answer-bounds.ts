import { BadRequestException, Logger } from '@nestjs/common';
import {
  PRODUCT_GRID_MAX_COLUMNS,
  PRODUCT_GRID_MAX_ROWS,
  PRODUCT_GRID_TYPE,
} from './product-grid-contract';

/**
 * THE BOUNDS OF A FORM AND OF AN ANSWER, AND THE CODES A SUBMIT OR A SAVE IS REFUSED WITH.
 *
 * Equal to `libs/contracts/form-answers.json`, which `answer-bounds.spec.ts` reads, and mirrored by
 * the fill page (`frontend/src/lib/forms/answerBounds.ts`), whose test reads the same file. The
 * page announces a bound before anyone sends (a `maxlength`, a counter) and words a refusal from
 * its CODE, never from the English sentence beside it - so every refusal of the submit path that a
 * person can meet carries one of these codes (D6 of the 2026-11-06 forms audit).
 *
 * WHY A GRID IS ITS OWN SHAPE. A survey grid (`matrix_single`, `matrix_multiple`) is answered
 * `{ rowLabel: optionId }` or `{ rowLabel: optionId[] }`. Until 2026-11-06 nothing on the server
 * accepted that shape: the DTO validator took a string, a string list or a number, so every form
 * holding a visible grid was refused at submit with an English 400 from 2026-06-01 on (D1). The
 * shape is judged here, against the question's own rows and columns, the way a priced choice is
 * judged against its options (`answer-options.ts`).
 */

const logger = new Logger('FormAnswerBounds');

/** The questions one form may hold, and so the keys one answer may carry. */
export const FORM_MAX_QUESTIONS = 100;
/** The characters of one text answer, a grid row's key included. */
export const ANSWER_MAX_TEXT_LENGTH = 2000;
/** The options one multi-select answer (or one grid row of a multiple grid) may tick. */
export const ANSWER_MAX_SELECTIONS = 50;
/** The rows one grid may declare, and so the keys one grid answer may carry. */
export const GRID_MAX_ROWS = 50;
/**
 * The cells one PRICED grid (`product_grid`) may have, and so the keys its answer may carry: its
 * answer is `{ "rowId:colId": quantity }`, one key per ordered cell, not one per row.
 */
export const PRODUCT_GRID_MAX_CELLS = PRODUCT_GRID_MAX_ROWS * PRODUCT_GRID_MAX_COLUMNS;
/** The characters of one priced-grid cell key: two ids of at most 36 and the `:` between them. */
export const PRODUCT_GRID_CELL_KEY_MAX = 73;

export const FORM_NOT_OPEN_YET = 'FORM_NOT_OPEN_YET';
export const FORM_CLOSED = 'FORM_CLOSED';
export const FORM_FULL = 'FORM_FULL';
export const FORM_ANSWER_MISSING = 'FORM_ANSWER_MISSING';
export const FORM_ANSWER_TOO_LONG = 'FORM_ANSWER_TOO_LONG';
export const FORM_ANSWER_TOO_MANY_SELECTIONS = 'FORM_ANSWER_TOO_MANY_SELECTIONS';
export const FORM_ANSWER_NOT_AN_OPTION = 'FORM_ANSWER_NOT_AN_OPTION';
export const FORM_GRID_ANSWER_INVALID = 'FORM_GRID_ANSWER_INVALID';
export const FORM_COMBINATION_UNAVAILABLE = 'FORM_COMBINATION_UNAVAILABLE';
export const FORM_SIGN_IN_REQUIRED = 'FORM_SIGN_IN_REQUIRED';
export const FORM_FILE_NEEDS_ACCOUNT = 'FORM_FILE_NEEDS_ACCOUNT';
export const FORM_GRID_DUPLICATE_LABEL = 'FORM_GRID_DUPLICATE_LABEL';
export const FORM_GRID_TOO_MANY_ROWS = 'FORM_GRID_TOO_MANY_ROWS';
export const FORM_TOO_MANY_QUESTIONS = 'FORM_TOO_MANY_QUESTIONS';
/**
 * A price grid splits a MULTIPLE-choice question into several groups (`answer-options.ts`): the
 * price would depend on the groups' order. `itemId` names the question.
 */
export const FORM_GRID_MULTIPLE_CHOICE_SPLIT = 'FORM_GRID_MULTIPLE_CHOICE_SPLIT';
/** A public form asks a guest for a name or an e-mail the answer does not carry (`guest-identity.ts`). */
export const FORM_GUEST_IDENTITY_MISSING = 'FORM_GUEST_IDENTITY_MISSING';
/** An answer carries a guest name or e-mail the form does not ask - or comes from a member. */
export const FORM_GUEST_IDENTITY_NOT_ASKED = 'FORM_GUEST_IDENTITY_NOT_ASKED';

/** The form does not let its answers be changed: the switch is off, or it is anonymous (`answer-edit.ts`). */
export const FORM_ANSWER_EDIT_OFF = 'FORM_ANSWER_EDIT_OFF';
/** An edit changes a question that touches the price; `itemId` names it (`answer-edit.ts`). */
export const FORM_ANSWER_LOCKED = 'FORM_ANSWER_LOCKED';
/** The row is no longer an answer (cancelled, expired, refunded): nothing left to change. */
export const FORM_ANSWER_NOT_EDITABLE = 'FORM_ANSWER_NOT_EDITABLE';
/** No answer of the caller's under this id - another person's answers the same (404). */
export const FORM_ANSWER_NOT_FOUND = 'FORM_ANSWER_NOT_FOUND';
/**
 * A manager deletes an answer whose payment was received (`PAID_SUBMISSION_STATUSES`): refused, the
 * answer is refunded or cancelled instead - its payment stays on the record (owner, 2026-11-14).
 */
export const FORM_ANSWER_PAID = 'FORM_ANSWER_PAID';
/** The payment statuses of an answer whose money was received and kept: it is never deleted. */
export const PAID_SUBMISSION_STATUSES = ['paid', 'paid_over_capacity'] as const;

/** The characters of a guest's last or first name (`submissions.guestLastName`, migration 138). */
export const GUEST_NAME_MAX_LENGTH = 100;
/** The characters of a guest's e-mail (`submissions.guestEmail`): RFC 5321's path limit. */
export const GUEST_EMAIL_MAX_LENGTH = 254;

/**
 * A 400 carrying a typed `code`, the shape every coded refusal of this service answers (`{ code,
 * message }`). `itemId` names the question when the refusal is about one, so the page can say which.
 */
export function formRefusal(code: string, message: string, itemId?: string): BadRequestException {
  return new BadRequestException({ code, message, ...(itemId ? { itemId } : {}) });
}

/** The two survey-grid types, whose answer is a map of rows. */
export function isGridQuestion(item: { type?: string }): boolean {
  return item.type === 'matrix_single' || item.type === 'matrix_multiple';
}

/**
 * One answer's value as the API accepts it: a text, a number, an id list, a survey grid's rows, or
 * a priced grid's cell quantities.
 */
export type FormAnswerValue =
  | string
  | string[]
  | number
  | Record<string, string | string[]>
  | Record<string, number>;

/** Whether `v` is a string list within the selection and text bounds. */
function isBoundedStringList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= ANSWER_MAX_SELECTIONS &&
    v.every((s) => typeof s === 'string' && s.length <= ANSWER_MAX_TEXT_LENGTH)
  );
}

/**
 * Whether one value of an `answers` record has an accepted SHAPE and size: a bounded string, a
 * bounded string list, a finite number, a flat object (a survey grid) of at most
 * {@link GRID_MAX_ROWS} bounded string keys whose values are bounded strings or string lists, or a
 * flat object (a priced grid) of at most {@link PRODUCT_GRID_MAX_CELLS} cell keys whose values are
 * all finite numbers. What the value MEANS (declared rows, declared options, declared cells, whole
 * quantities within the cap) is judged by `submit`, which has the form (`answer-bounds.ts` for a
 * survey grid, `product-grid-contract.ts` for a priced one).
 */
export function isAcceptedAnswerValue(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= ANSWER_MAX_TEXT_LENGTH;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return isBoundedStringList(v);
  if (typeof v !== 'object' || v === null) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  // A priced grid's quantities: every value a number. Never mixed with a survey row's strings.
  if (entries.length > 0 && entries.every(([, cell]) => typeof cell === 'number')) {
    return (
      entries.length <= PRODUCT_GRID_MAX_CELLS &&
      entries.every(
        ([key, cell]) => key.length <= PRODUCT_GRID_CELL_KEY_MAX && Number.isFinite(cell as number)
      )
    );
  }
  if (entries.length > GRID_MAX_ROWS) return false;
  return entries.every(
    ([key, cell]) =>
      key.length <= ANSWER_MAX_TEXT_LENGTH &&
      ((typeof cell === 'string' && cell.length <= ANSWER_MAX_TEXT_LENGTH) ||
        isBoundedStringList(cell))
  );
}

/** A single value counts when it is neither empty nor absent - `0` IS an answer (a scale at 0). */
function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== '' && value !== undefined && value !== null;
}

/** The subset of a stored question the grid checks read. */
export interface GridItem {
  id: string;
  type?: string;
  label?: string;
  required?: boolean;
  rows?: string[] | null;
  options?: { id?: string; label?: string }[] | null;
  /** A required grid demands EVERY row only when this is on; otherwise one row is enough (D5). */
  requireEveryRow?: boolean;
}

/**
 * Whether a question counts as answered - THE rule `submit` applies to a required question, the
 * same one the fill page applies (`fillAnswers.ts` `isItemAnswered`).
 *
 * A grid is answered when at least one of its rows is, or - with `requireEveryRow` - when every
 * declared row is (decided 2026-11-06, D5: an order "which colours" is answered by one row, and a
 * survey that needs every row says so). Anything else is answered when it holds a value; a zero is
 * one, which the old `!!val` refused for a scale starting at 0.
 */
export function isQuestionAnswered(item: GridItem, value: unknown): boolean {
  if (isGridQuestion(item)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const rows = value as Record<string, unknown>;
    // Own keys only: a row labelled `constructor` must not read the prototype's as an answer.
    if (item.requireEveryRow) {
      return (item.rows ?? []).every(
        (row) => Object.prototype.hasOwnProperty.call(rows, row) && hasValue(rows[row])
      );
    }
    return Object.values(rows).some(hasValue);
  }
  return hasValue(value);
}

/**
 * A grid answer checked against its question and stripped of its empty rows, or `undefined` when
 * no row is answered (the answer is then absent, like any unanswered question).
 *
 * Every key must be one of the question's rows; a `matrix_single` row holds one of its column ids,
 * a `matrix_multiple` row a list of distinct ones. Anything else is the typed 400
 * {@link FORM_GRID_ANSWER_INVALID} - a forged or stale answer, never a person's mistake, since the
 * page offers only the declared cells. An empty row (`''`, `[]`) is what an older page sends for a
 * row left blank, and is dropped rather than refused.
 */
export function normaliseGridAnswer(
  item: GridItem,
  value: unknown
): Record<string, string | string[]> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const refuse = (why: string) => {
    logger.log(`[FORMS] grid answer refused item=${item.id.slice(0, 8)}: ${why}`);
    return formRefusal(
      FORM_GRID_ANSWER_INVALID,
      `Answer for field ${item.label ?? item.id} is not a grid answer of its rows and columns.`,
      item.id
    );
  };
  if (typeof value !== 'object' || Array.isArray(value)) throw refuse('not an object');
  const rows = new Set(item.rows ?? []);
  const columns = new Set((item.options ?? []).map((o) => o.id).filter(Boolean));
  const multiple = item.type === 'matrix_multiple';
  // Collected as entries and built with `fromEntries`, which DEFINES each key: a row an organiser
  // labelled `__proto__` is kept as that row rather than assigned to the map's prototype.
  const kept: [string, string | string[]][] = [];
  for (const [row, cell] of Object.entries(value as Record<string, unknown>)) {
    if (!rows.has(row)) throw refuse('an undeclared row');
    if (!hasValue(cell)) continue;
    if (multiple) {
      if (!Array.isArray(cell)) throw refuse('a multiple row that is not a list');
      const valid =
        new Set(cell).size === cell.length &&
        cell.every((id) => typeof id === 'string' && columns.has(id));
      if (!valid) throw refuse('an undeclared or repeated column');
      kept.push([row, cell as string[]]);
    } else {
      if (typeof cell !== 'string' || !columns.has(cell)) throw refuse('an undeclared column');
      kept.push([row, cell]);
    }
  }
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The subset of a question the save-time shape checks read. */
interface SavedItem {
  id?: string;
  type?: string;
  label?: string;
  rows?: string[] | null;
  options?: { label?: string }[] | null;
}

/** The first label that occurs twice in `labels`, or null. Compared exactly: it is the answer key. */
function firstDuplicate(labels: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) return label;
    seen.add(label);
  }
  return null;
}

/**
 * Refuses, with a typed 400, a form whose questions could not be answered in full or read back:
 * more than {@link FORM_MAX_QUESTIONS} questions (an answer may carry no more keys than that), a
 * grid of more than {@link GRID_MAX_ROWS} rows, or a grid with two rows or two columns of one label.
 *
 * A grid answer is keyed by its row LABEL, so two rows of one label were one answer and one radio
 * group (D4); two columns of one label are two cells nobody can tell apart in the answer's text.
 * Refused where it is typed, and the editor marks the duplicate inline before the save.
 */
export function assertFormItemsShape(items: readonly SavedItem[] | null | undefined): void {
  const list = items ?? [];
  if (list.length > FORM_MAX_QUESTIONS) {
    throw formRefusal(
      FORM_TOO_MANY_QUESTIONS,
      `A form holds at most ${FORM_MAX_QUESTIONS} questions.`
    );
  }
  for (const item of list) {
    if (!isGridQuestion(item)) continue;
    const rows = item.rows ?? [];
    if (rows.length > GRID_MAX_ROWS) {
      throw formRefusal(
        FORM_GRID_TOO_MANY_ROWS,
        `A grid holds at most ${GRID_MAX_ROWS} rows (${item.label ?? item.id}).`,
        item.id
      );
    }
    const duplicate =
      firstDuplicate(rows) ?? firstDuplicate((item.options ?? []).map((o) => o.label ?? ''));
    if (duplicate !== null) {
      throw formRefusal(
        FORM_GRID_DUPLICATE_LABEL,
        `Grid "${item.label ?? item.id}" names "${duplicate}" twice: each row and each column needs its own label.`,
        item.id
      );
    }
  }
}

/** Whether `v` is a grid-shaped value: an object that is not a list. */
function isRowMap(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `answers` with every grid question's answer checked and stripped of its empty rows
 * ({@link normaliseGridAnswer}); a grid with no answered row is left out, as any unanswered
 * question.
 *
 * A row map is a GRID's shape and nothing else's: the DTO accepts it for any key, so it is judged
 * here against the form. On a declared question that is not a grid it is the typed
 * {@link FORM_GRID_ANSWER_INVALID} (a page opened before the question stopped being a grid - the
 * refusal says to reload); on a key the form does not declare it is dropped, as a stale page's
 * answer to a since-deleted grid (`{ row: '' }`) must not fail the send. A priced grid's
 * (`product_grid`) answer passes through to its own rule in `submit`. Every other value is
 * returned untouched - its own checks run where they always did.
 */
export function withNormalisedGridAnswers<T>(
  items: readonly GridItem[],
  answers: Record<string, T>
): Record<string, T> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: [string, T][] = [];
  for (const [key, value] of Object.entries(answers)) {
    const item = byId.get(key);
    if (item && isGridQuestion(item)) {
      const grid = normaliseGridAnswer(item, value);
      if (grid !== undefined) out.push([key, grid as T]);
      continue;
    }
    // A priced grid's answer is a map too, judged by its own coded rule in `submit`
    // (`priceProductGridAnswer`): passed through untouched, never refused here as a stray row map.
    if (item?.type === PRODUCT_GRID_TYPE) {
      out.push([key, value]);
      continue;
    }
    if (!isRowMap(value)) {
      out.push([key, value]);
      continue;
    }
    if (!item) {
      logger.log(`[FORMS] a row map on an undeclared key dropped key=${key.slice(0, 8)}`);
      continue;
    }
    logger.log(`[FORMS] a row map refused on a non-grid item=${item.id.slice(0, 8)}`);
    throw formRefusal(
      FORM_GRID_ANSWER_INVALID,
      `Answer for field ${item.label ?? item.id} is a grid answer, and the question is not a grid.`,
      item.id
    );
  }
  return Object.fromEntries(out);
}
