import { answerText } from './answerText';
import type { FormItem } from './api';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

/**
 * HOW ONE FORM'S RESPONSES LAY THEMSELVES OUT, which is a question about the FORM and not about the
 * viewport.
 *
 * The responses table used to print four fixed columns - date, name, status, amount - and none of
 * the answers, so the one thing a manager opened it for was the one thing it did not show. Adding a
 * column per question is not the answer either: a form has as many questions as it likes, and three
 * of the eight question types have no bounded length at all.
 *
 * So the layout is derived here, per form: the short questions become columns, everything else is
 * read in the row's detail panel. A form of three short questions lays itself flat; a form of twenty
 * paragraphs keeps its four columns and puts everything in the panel. Neither needs a setting.
 */

/**
 * The question types whose answer is short enough to be a table COLUMN.
 *
 * A column is a fixed, narrow box repeated down the page, so what may go in one is decided by the
 * SHAPE of the answer and not by its length on a given day: a paragraph, a checkbox list and a
 * matrix have no bound, and one long answer would set the height of every row in the table.
 */
const COLUMN_TYPES = new Set(['short_text', 'single_choice', 'dropdown', 'linear_scale']);

/**
 * How many answer columns the table may add to the four it already carries.
 *
 * Measured against the `tool` width this page moved to (1024px, `pageWidth.ts`): date, name, status,
 * amount and the delete control take about 470px, leaving room for three columns of ~180px. A fourth
 * is where a cell stops holding a short answer and starts truncating it.
 */
export const MAX_ANSWER_COLUMNS = 3;

/**
 * The questions that become columns of the table, for this form.
 *
 * A CONDITIONAL question never does, whatever its type. `dependsOn` and `showIf` are asked of a
 * subset of submitters by construction, so a column for one is a column of blanks with a handful of
 * values in it - it costs every row its width and answers about almost nobody. Those read in the
 * panel, where an unasked question is simply an absent line.
 */
export function answerColumns(items: FormItem[], max = MAX_ANSWER_COLUMNS): FormItem[] {
  return items
    .filter((item) => COLUMN_TYPES.has(item.type) && !item.dependsOn && !item.showIf)
    .slice(0, max);
}

/** A question paired with what one submitter answered to it. */
export interface AnsweredItem {
  item: FormItem;
  text: string;
}

/**
 * Everything one submitter actually answered, in the form's own question order.
 *
 * Driven by `items` and never by the answer keys, which is what the export does too: a value whose
 * question has since been deleted has no label, and a value under no heading is not a reading of
 * anything. A question left blank is dropped rather than shown as a dash - the panel is one person's
 * answers, and a list of what they did not say is longer than the list of what they did.
 */
export function answeredItems(
  items: FormItem[],
  answers: Record<string, unknown> | undefined
): AnsweredItem[] {
  if (!answers) return [];
  return items
    .map((item) => ({ item, text: answerText(answers[item.id], item) }))
    .filter((answered) => answered.text !== '');
}

/**
 * The name a response is filed under.
 *
 * The submitter's real name when the account carries one, and their display name when it does not.
 * Shared because the table prints it and the delete confirmation has to name the SAME person - they
 * were two expressions of this until 2026-09-20, which is one rename away from a dialog asking
 * about somebody else.
 */
export function submitterName(sub: {
  firstName: string | null;
  lastName: string | null;
  userId: string;
}): string {
  const real = [sub.firstName, sub.lastName].filter(Boolean).join(' ');
  return real || getUserDisplayNameSync(sub.userId);
}
