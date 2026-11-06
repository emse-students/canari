import { GRID_MAX_ROWS, duplicateLabels, gridRowLabels } from '$lib/forms/answerBounds';

/**
 * WHICH QUESTION A REFUSED SAVE IS ABOUT, so the editor can open its folded card.
 *
 * Only a refusal that belongs to one question is answered with one: a form-level refusal (the file
 * rule on a public form, say) has no question to blame and returns nothing here.
 */

/** The first question whose audience condition is switched on and empty. */
export function firstEmptyConditionQuestion(
  items: readonly { id: string; showIf?: object | null }[]
): string | null {
  return items.find((q) => q.showIf != null && Object.keys(q.showIf).length === 0)?.id ?? null;
}

/**
 * The first grid that `formItemsProblem` refuses: a label twice among its rows or columns, or too
 * many rows - opened so the "En double" mark under the field is visible.
 */
export function firstItemsFaultQuestion(
  items: readonly {
    id: string;
    type?: string;
    rows?: readonly ({ value?: string } | string)[];
    options?: readonly { label?: string }[];
  }[]
): string | null {
  for (const item of items) {
    if (item.type !== 'matrix_single' && item.type !== 'matrix_multiple') continue;
    const rows = gridRowLabels(item.rows as any).filter(Boolean);
    const columns = (item.options ?? []).filter((o) => o.label?.trim()).map((o) => o.label!);
    if (
      rows.length > GRID_MAX_ROWS ||
      duplicateLabels(rows).size > 0 ||
      duplicateLabels(columns).size > 0
    ) {
      return item.id;
    }
  }
  return null;
}
