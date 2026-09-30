import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { FormItem } from './api';

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

/** Whether this question has an answer: every row, for a matrix; one value otherwise. */
export function isItemAnswered(item: FormItem, value: unknown): boolean {
  if (isMatrix(item)) {
    if (!value || typeof value !== 'object') return false;
    return (item.rows ?? []).every((row) => hasValue((value as Record<string, unknown>)[row]));
  }
  return hasValue(value);
}

/** Why a required question is not answered yet - what the page has to say about it. */
export type MissingAnswer =
  | { kind: 'matrix'; label: string }
  | { kind: 'row'; label: string; row: string }
  | { kind: 'select'; label: string }
  | { kind: 'answer'; label: string };

/**
 * The first REQUIRED question, in order, that has no answer - or null when the form may be sent.
 *
 * Optional questions never block, which is what `allRequiredAnswered` and the submit button both
 * rely on. The kind names the sentence: a matrix without an answer, one of its rows, an empty choice
 * list, or anything else.
 */
export function firstMissingAnswer(
  items: FormItem[],
  selections: Selections
): MissingAnswer | null {
  for (const item of items) {
    if (!item.required) continue;
    const value = selections[item.id];
    if (isMatrix(item)) {
      if (!value || typeof value !== 'object') return { kind: 'matrix', label: item.label };
      const row = (item.rows ?? []).find((r) => !hasValue((value as Record<string, unknown>)[r]));
      if (row !== undefined) return { kind: 'row', label: item.label, row };
    } else if (Array.isArray(value) || item.type === 'multiple_choice') {
      if (!hasValue(value)) return { kind: 'select', label: item.label };
    } else if (!hasValue(value)) {
      return { kind: 'answer', label: item.label };
    }
  }
  return null;
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
    case 'answer':
      return m.form_view_error_answer({ label: missing.label });
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

/** Only the answers to questions the person could see - what the server is sent. */
export function visibleAnswers(visible: FormItem[], selections: Selections): Selections {
  const ids = new Set(visible.map((item) => item.id));
  return Object.fromEntries(Object.entries(selections).filter(([id]) => ids.has(id)));
}

/** An amount in cents, in the reader's locale. Empty for an undefined amount. */
export function formatAmount(amountCents: number | undefined, currency = 'eur'): string {
  if (amountCents === undefined) return '';
  return new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}
