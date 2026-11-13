import { tick } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { intlLocale } from '$lib/utils/intlLocale';
import type { FormItem } from './api';
import { hasOrderedUnits, isProductGrid } from './productGridFill';
import { FILLABLE_QUESTION_TYPE_VALUES } from './questionTypes';

/**
 * WHAT A PERSON FILLING A FORM HAS ANSWERED - the rules the fill page applies, taken out of it.
 *
 * They lived inline in `routes/forms/[id]/+page.svelte`, and one of them twice: the submit
 * validation said `!val` while the progress bar said `val !== ''`, so a linear scale starting at 0
 * counted as answered on the bar and was refused by the button. One predicate now answers both, and
 * it is the one a second page (a form opened without an account) reuses rather than copies.
 */

/** A selection per question id: a string, a number, an id list, or a row map for a matrix. */
export type Selections = Record<string, any>;

/** The empty selection each question type starts from - the shape `bind:group` needs to exist. */
export function initialSelections(items: FormItem[]): Selections {
  const initial: Selections = {};
  for (const item of items) {
    if (item.type === 'multiple_choice') {
      initial[item.id] = [];
    } else if (isProductGrid(item)) {
      // A priced grid's answer: `"rowId:colId"` -> quantity, holding only the cells ordered.
      initial[item.id] = {};
    } else if (isMatrix(item)) {
      initial[item.id] = {};
      for (const row of item.rows ?? []) {
        initial[item.id][row] = item.type === 'matrix_multiple' ? [] : '';
      }
    } else {
      initial[item.id] = '';
    }
  }
  return initial;
}

/** Whether a question is one of the two grid types, whose answer is a map of rows. */
export function isMatrix(item: Pick<FormItem, 'type'>): boolean {
  return item.type === 'matrix_single' || item.type === 'matrix_multiple';
}

/** A single value counts when it is neither empty nor absent - `0` IS an answer. */
function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== '' && value !== undefined && value !== null;
}

/** The types this build can draw an input for; any other is a newer type it cannot answer. */
const KNOWN_TYPES = new Set([...FILLABLE_QUESTION_TYPE_VALUES, 'single']);

/**
 * Whether this build knows how to answer a question type. A type this build cannot draw - one added
 * after this release - is drawn as "update the app" and blocks a send when required, rather than
 * going out empty for the server to refuse in English.
 */
export function isKnownQuestionType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

/**
 * Whether this question has an answer - the rule the server applies to a required question
 * (`answer-bounds.ts` `isQuestionAnswered`). A grid is answered by ONE row, or by every row when
 * the question says `requireEveryRow` (decided 2026-11-06, D5). A priced grid is answered by one
 * unit ordered (an empty object is not an order: `productGridOrdered`, the submit's own predicate);
 * anything else by one value.
 */
export function isItemAnswered(item: FormItem, value: unknown): boolean {
  if (isProductGrid(item)) return hasOrderedUnits(value);
  if (isMatrix(item)) {
    if (!value || typeof value !== 'object') return false;
    const rows = value as Record<string, unknown>;
    if (item.requireEveryRow) return (item.rows ?? []).every((row) => hasValue(rows[row]));
    return (item.rows ?? []).some((row) => hasValue(rows[row]));
  }
  return hasValue(value);
}

/**
 * Why the form cannot be sent yet - what the page has to say, and which question (`itemId`), so the
 * page can mark that card and bring it into view. `order` is the FORM's ([LEGACY], an estate older
 * than each grid's switch, `gridRequiredSwitchOn` false): no question is at fault (`itemId` null),
 * the page says it beside its send button.
 */
export type MissingAnswer =
  | ({ itemId: string } & (
      | { kind: 'matrix'; label: string }
      | { kind: 'row'; label: string; row: string }
      | { kind: 'select'; label: string }
      | { kind: 'grid'; label: string }
      | { kind: 'answer'; label: string }
      | { kind: 'update'; label: string }
    ))
  | { itemId: null; kind: 'order' };

/**
 * The first REQUIRED question, in order, that has no answer - or null when the form may be sent.
 *
 * Optional questions never block, which is what `allRequiredAnswered` and the submit button both
 * rely on. The kind names the sentence: a matrix without an answer, one of its rows, an empty choice
 * list, a priced grid with no unit, or anything else.
 *
 * A PRICED GRID is required by its own "Obligatoire" switch (owner, 2026-11-13), off by default, and
 * then wants ONE unit of its own; a grid the person does not see is not in `items` (the VISIBLE
 * questions), so it is never demanded. No rule spans the grids: a form whose grids are all optional
 * is sent with no article.
 *
 * `gridSwitch` false ([LEGACY], an estate older than the switch, `gridRequiredSwitchOn`): that
 * server stores every grid required and means nothing by it, and demands the ORDER - one unit across
 * the visible grids (`PRODUCT_GRID_EMPTY`). So a grid is skipped whatever its flag, and an empty
 * order is answered last, `{ itemId: null, kind: 'order' }`.
 */
export function firstMissingAnswer(
  items: FormItem[],
  selections: Selections,
  gridSwitch: boolean
): MissingAnswer | null {
  for (const item of items) {
    if (!item.required) continue;
    if (!gridSwitch && isProductGrid(item)) continue;
    const value = selections[item.id];
    const itemId = item.id;
    if (!isKnownQuestionType(item.type)) {
      return { itemId, kind: 'update', label: item.label };
    } else if (isProductGrid(item)) {
      if (!isItemAnswered(item, value)) return { itemId, kind: 'grid', label: item.label };
    } else if (isMatrix(item)) {
      const rows = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      if (item.requireEveryRow) {
        const row = (item.rows ?? []).find((r) => !hasValue(rows[r]));
        if (row !== undefined) return { itemId, kind: 'row', label: item.label, row };
      } else if (!isItemAnswered(item, rows)) {
        return { itemId, kind: 'matrix', label: item.label };
      }
    } else if (Array.isArray(value) || item.type === 'multiple_choice') {
      if (!hasValue(value)) return { itemId, kind: 'select', label: item.label };
    } else if (!hasValue(value)) {
      return { itemId, kind: 'answer', label: item.label };
    }
  }
  if (!gridSwitch && isOrderEmpty(items, selections)) return { itemId: null, kind: 'order' };
  return null;
}

/**
 * [LEGACY] Whether `items` (the VISIBLE questions) hold priced grids and not one unit is ordered
 * across them - the ORDER rule of an estate older than each grid's switch (`PRODUCT_GRID_EMPTY`).
 * False on a form showing no grid. Read only while `gridRequiredSwitchOn` is false.
 */
export function isOrderEmpty(items: FormItem[], selections: Selections): boolean {
  const grids = items.filter(isProductGrid);
  return grids.length > 0 && !grids.some((item) => hasOrderedUnits(selections[item.id]));
}

/** [LEGACY] The id of the fill pages' empty-order sentence, which `revealOrderMissing` brings into view. */
export const ORDER_MISSING_ID = 'form-order-missing';

/**
 * [LEGACY] Brings the empty-order sentence into view once the page has drawn it: the sticky order
 * bar of a grid form hides the end of the page, where both fill pages say it.
 */
export async function revealOrderMissing(): Promise<void> {
  await tick();
  document
    .getElementById(ORDER_MISSING_ID)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Whether every REQUIRED visible question is answered - the same rule `firstMissingAnswer` applies,
 * as a yes/no, under the same `gridSwitch`.
 */
export function allRequiredAnswered(
  items: FormItem[],
  selections: Selections,
  gridSwitch: boolean
): boolean {
  return firstMissingAnswer(items, selections, gridSwitch) === null;
}

/** The sentence for a missing answer, in the reader's language. */
export function missingAnswerMessage(missing: MissingAnswer): string {
  switch (missing.kind) {
    case 'matrix':
      return m.form_view_error_complete_matrix({ label: missing.label });
    case 'row':
      return m.form_view_error_complete_row({ row: missing.row, label: missing.label });
    case 'select':
      return m.form_view_error_select_option({ label: missing.label });
    case 'grid':
      return m.form_view_error_grid_empty({ label: missing.label });
    case 'order':
      return m.form_view_error_order_empty();
    case 'answer':
      return m.form_view_error_answer({ label: missing.label });
    case 'update':
      return m.form_view_error_update_app({ label: missing.label });
  }
}

/**
 * The questions this person is shown, given what they have answered so far.
 *
 * The PROFILE half of a condition is decided by the server (`hiddenIds`): a browser cannot be
 * trusted with someone's cotisation or promo. What is left is the ANSWER half - a question shown
 * only when another was answered a given way, through `showIf.answer` or the legacy
 * `dependsOn`/`dependsValue` pair.
 */
export function visibleItems(
  items: FormItem[],
  selections: Selections,
  hiddenIds: ReadonlySet<string> = new Set()
): FormItem[] {
  return items.filter((item) => {
    if (hiddenIds.has(item.id)) return false;
    const condition = item.showIf?.answer
      ? { questionId: item.showIf.answer.questionId, optionIds: item.showIf.answer.optionIds }
      : item.dependsOn
        ? { questionId: item.dependsOn, optionIds: [item.dependsValue ?? ''] }
        : null;
    if (!condition) return true;
    if (hiddenIds.has(condition.questionId)) return false;
    const dep = selections[condition.questionId];
    if (dep === undefined || dep === null || dep === '') return false;
    if (Array.isArray(dep)) return (dep as string[]).some((v) => condition.optionIds.includes(v));
    return condition.optionIds.includes(String(dep));
  });
}

/**
 * The priced questions whose answer has NOT CHOSEN a cell yet: shown, required, and unanswered.
 *
 * An unanswered question falls in the grid's "others" group, which is the right cell for an OPTIONAL
 * question left blank - that is what the server prices - but not for a required one, whose blank
 * is only "not chosen yet". Pricing that blank called the paid form "Cotisation BDE 2026"
 * "Combinaison indisponible" before any answer (Mi 9T, v1.2.9-alpha.3).
 */
export function pricedQuestionsAwaitingAnswer(
  visible: FormItem[],
  pricedQuestionIds: readonly string[],
  selections: Selections
): Set<string> {
  const priced = new Set(pricedQuestionIds);
  return new Set(
    visible
      .filter(
        (item) => priced.has(item.id) && item.required && !isItemAnswered(item, selections[item.id])
      )
      .map((item) => item.id)
  );
}

/**
 * Only the ANSWERED questions the person could see - what the server is sent.
 *
 * An unanswered question is left out rather than sent empty: a grid's seeded `{ row: '' }` map
 * went out for every visible grid, and every empty selection counted against the server's cap on
 * an answer's keys, so a form of more than fifty visible questions was refused whatever was filled
 * (D3 of the 2026-11-06 audit). A grid keeps only its answered rows. The server judges a required
 * question by the same rule (`isItemAnswered`), so leaving one out says the same as sending it empty.
 */
export function visibleAnswers(visible: FormItem[], selections: Selections): Selections {
  const out: Selections = {};
  for (const item of visible) {
    const value = selections[item.id];
    if (isProductGrid(item)) {
      // An order holds only its ordered cells already (`withCellQuantity`); an empty one stays out.
      if (hasOrderedUnits(value)) out[item.id] = value;
    } else if (isMatrix(item)) {
      if (!value || typeof value !== 'object') continue;
      const rows = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, cell]) => hasValue(cell))
      );
      if (Object.keys(rows).length > 0) out[item.id] = rows;
    } else if (hasValue(value)) {
      out[item.id] = value;
    }
  }
  return out;
}

/**
 * The selections to show for an answer read back from the server: its values over the empty shape
 * each question starts from. A stored grid holds only its answered rows (`visibleAnswers`), and a
 * row's input binds to its key, so the missing rows are seeded again here.
 */
export function selectionsFromAnswers(items: FormItem[], answers: Selections): Selections {
  const out = initialSelections(items);
  for (const [id, value] of Object.entries(answers)) {
    const item = items.find((i) => i.id === id);
    out[id] =
      item && isMatrix(item) && value && typeof value === 'object'
        ? { ...out[id], ...(value as Record<string, unknown>) }
        : value;
  }
  return out;
}

/** An amount in cents, in the reader's locale. Empty for an undefined amount. */
export function formatAmount(amountCents: number | undefined, currency = 'eur'): string {
  if (amountCents === undefined) return '';
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: (currency || 'eur').toUpperCase(),
  }).format(amountCents / 100);
}
