import { SocialApiError } from '$lib/associations/api';
import { GRID_MAX_ROWS, duplicateLabels, gridRowLabels } from '$lib/forms/answerBounds';
import { PRODUCT_GRID_TYPE } from '$lib/forms/productGridContract';
import {
  productGridDefinitionMessage,
  productGridFault,
  type ProductGridFault,
} from '$lib/forms/productGridEditor';

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

/**
 * The priced grid a REFUSED SAVE names, with its sentence: the server's coded 400 for a grid
 * definition (`PRODUCT_GRID_TIER_INVALID` - a cotisation tier the association does not sell, which
 * only the server can know - and every other `PRODUCT_GRID_*` definition code) carries the question
 * in `itemId`, so the page draws it under that grid and opens its card, as it does for its own
 * check. Null for any other refusal, or one naming no grid of `items` (the page then keeps its
 * banner alone).
 */
export function refusedProductGridFault(
  error: unknown,
  items: readonly { id: string; label?: string; type?: string }[]
): ProductGridFault | null {
  if (!(error instanceof SocialApiError) || !error.code) return null;
  if (productGridDefinitionMessage(error.code) === null) return null;
  const item = items.find((i) => i.id === error.itemId && i.type === PRODUCT_GRID_TYPE);
  if (!item) {
    // The server names every grid it refuses: a code naming none of ours is a contract break.
    console.error(
      `[forms] ${error.code} names item ${error.itemId ?? 'none'}, no priced grid of this form`
    );
    return null;
  }
  return productGridFault(item, error.code);
}
