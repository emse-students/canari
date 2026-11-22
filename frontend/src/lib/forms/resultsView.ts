import type { FormItem } from './api';

/**
 * WHAT THE "RÉSUMÉ" TAB DRAWS FROM THE SERVER'S RESULTS, AS PURE FUNCTIONS (G-RESULTS).
 *
 * The counts come from `GET /forms/:id/results` - SQL aggregates, never the answers shipped to the
 * browser. What stays here is presentation arithmetic that must not differ between a bar and its
 * label: the share a count is of its question's `answered`, and which questions the tab exists for.
 */

/** The question types the server summarises; the rest (a file, a text block) have no results. */
const RESULT_TYPES = new Set([
  'single_choice',
  'multiple_choice',
  'dropdown',
  'single',
  'linear_scale',
  'matrix_single',
  'matrix_multiple',
  'product_grid',
  'short_text',
  'long_text',
]);

/** Whether the "Résumé" tab has anything to say about this form. */
export function hasResultQuestions(items: readonly Pick<FormItem, 'type'>[]): boolean {
  return items.some((item) => RESULT_TYPES.has(item.type));
}

/**
 * A count as a whole percentage of the answers to ITS question (never of the form's total: a
 * question behind a condition is answered by few). 0 when nobody answered.
 */
export function percentOf(count: number, answered: number): number {
  return answered > 0 ? Math.round((100 * count) / answered) : 0;
}

/** A scale's mean to one decimal in the reader's locale, `-` when nobody answered. */
export function formatMean(mean: number | null, locale: string): string {
  return mean === null
    ? '-'
    : mean.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The longest bar of a list, never 0, so a bar's width is `count / longest`. */
export function longest(counts: readonly number[]): number {
  return Math.max(1, ...counts);
}
