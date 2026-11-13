import { m } from '$lib/paraglide/messages';
import type { FormItem } from './api';
import {
  PRODUCT_GRID_ALL_TIER,
  PRODUCT_GRID_OTHERS_TIER,
  PRODUCT_GRID_TYPE,
  parseProductGridAnswer,
  productGridAxisKey,
  productGridCellKey,
  productGridLines,
  productGridOrdered,
  type ProductGridAnswer,
  type ProductGridAnswerCode,
  type ProductGridLine,
  type ProductGridPrices,
  type ProductGridView,
  type ProductGridViewerPrices,
} from './productGridContract';

/**
 * THE PRICED GRID ON A FILL PAGE (`product_grid`, WP-G2) - what a respondent's clicks do to the
 * answer, what the page totals, and how a refusal reads.
 *
 * The rules themselves live in `productGridContract.ts`, the file the server holds a byte copy of:
 * this module only applies them to the page's state. The total built here is a PREVIEW - the server
 * recomputes every line from the stored grid at submit, and that figure is what is charged.
 */

/** Whether a question is a priced grid. */
export function isProductGrid(item: Pick<FormItem, 'type'>): boolean {
  return item.type === PRODUCT_GRID_TYPE;
}

/** The quantity a cell holds in an answer; 0 for a cell never touched, or a malformed answer. */
export function cellQuantity(answer: unknown, rowId: string, colId: string): number {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 0;
  const value = (answer as Record<string, unknown>)[productGridCellKey(rowId, colId)];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * The answer with one cell set, as a NEW object (the page's `bind:value` sees a write): the
 * quantity is clamped to 0..`maxPerCell`, and a cell at 0 is dropped, so the answer only ever holds
 * the cells ordered - the shape the server stores.
 */
export function withCellQuantity(
  answer: unknown,
  grid: Pick<ProductGridView, 'maxPerCell'>,
  rowId: string,
  colId: string,
  quantity: number
): ProductGridAnswer {
  const next: ProductGridAnswer =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? { ...(answer as ProductGridAnswer) }
      : {};
  const key = productGridCellKey(rowId, colId);
  const clamped = Math.max(0, Math.min(grid.maxPerCell, Math.trunc(quantity)));
  if (clamped === 0) delete next[key];
  else next[key] = clamped;
  return next;
}

/** Whether a cell is a combination that does not exist ("no Creme in XS"). */
export function isCellClosed(
  grid: Pick<ProductGridView, 'closedCells'>,
  rowId: string,
  colId: string
): boolean {
  return (grid.closedCells ?? []).includes(productGridCellKey(rowId, colId));
}

/**
 * Whether an answer orders at least one unit - what a REQUIRED grid needs to be sent. The
 * contract's predicate (`productGridOrdered`), the one the submit reads too.
 */
export const hasOrderedUnits = productGridOrdered;

/**
 * The price of one unit of a cell for this viewer, or null when their price list has none.
 *
 * A missing price is a grid that broke the save-time completeness rule, or a page the server did not
 * tell its prices: it is reported, never read as free.
 */
export function cellUnitCents(
  grid: Pick<ProductGridView, 'pricing'>,
  viewer: ProductGridViewerPrices | undefined,
  rowId: string,
  colId: string
): number | null {
  if (!viewer) return null;
  const key = productGridAxisKey(grid.pricing.mode, rowId, colId);
  return Object.prototype.hasOwnProperty.call(viewer.prices, key) ? viewer.prices[key] : null;
}

/** The lowest unit price of a grid for this viewer - the "from" price a card header shows. */
export function lowestUnitCents(
  grid: Pick<ProductGridView, 'rows' | 'columns' | 'closedCells' | 'pricing'>,
  viewer: ProductGridViewerPrices | undefined
): number | null {
  let lowest: number | null = null;
  for (const row of grid.rows) {
    for (const col of grid.columns) {
      if (isCellClosed(grid, row.id, col.id)) continue;
      const cents = cellUnitCents(grid, viewer, row.id, col.id);
      if (cents !== null && (lowest === null || cents < lowest)) lowest = cents;
    }
  }
  return lowest;
}

/**
 * Every priced line of every VISIBLE grid on the form, in the form's order - what the sticky total
 * adds up and the recap lists.
 *
 * A grid with nothing ordered yet adds no line. A grid the server sent no prices for, or whose
 * answer the contract refuses, adds none either - and says so at error level: the page would
 * otherwise show a total the submit is going to contradict.
 */
export function productGridOrderLines(
  visible: readonly FormItem[],
  selections: Record<string, unknown>,
  prices: ProductGridPrices | null | undefined
): ProductGridLine[] {
  const lines: ProductGridLine[] = [];
  for (const item of visible) {
    if (!isProductGrid(item) || !item.productGrid) continue;
    const answer = selections[item.id];
    if (!hasOrderedUnits(answer)) continue;
    const viewer = prices?.[item.id];
    if (!viewer) {
      console.error(`[FORMS] product grid ${item.id} has no prices for this viewer - not totalled`);
      continue;
    }
    const judged = parseProductGridAnswer(item.productGrid, answer);
    if (!judged.ok) {
      console.error(`[FORMS] product grid ${item.id} answer refused locally: ${judged.code}`);
      continue;
    }
    try {
      lines.push(
        ...productGridLines(
          { id: item.id, label: item.label, productGrid: item.productGrid },
          judged.answer,
          viewer
        )
      );
    } catch (err) {
      console.error(`[FORMS] product grid ${item.id} could not be priced:`, err);
    }
  }
  return lines;
}

/**
 * What one recap line reads as: "Sweat capuche Noir M". The row is left out of a grid with a single
 * row, which has no row label on screen either.
 */
export function orderLineLabel(line: ProductGridLine, items: readonly FormItem[]): string {
  const grid = items.find((item) => item.id === line.itemId)?.productGrid;
  const singleRow = (grid?.rows.length ?? 0) === 1;
  return [line.itemLabel, singleRow ? null : line.rowLabel, line.colLabel]
    .filter((part): part is string => !!part)
    .join(' ');
}

/** The number of units in some lines. */
export function orderUnitCount(lines: readonly ProductGridLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * The category a viewer is charged under, worded: the bucket's own label, "everyone else" for
 * `_others`. Null for `_all` - a grid with one price list for everybody has no category to name.
 */
export function viewerTierLabel(viewer: ProductGridViewerPrices): string | null {
  if (viewer.tierId === PRODUCT_GRID_ALL_TIER) return null;
  if (viewer.tierLabel) return viewer.tierLabel;
  if (viewer.tierId === PRODUCT_GRID_OTHERS_TIER) return m.form_criterion_others();
  return null;
}

/**
 * The categories this viewer is charged under across the form's visible grids, each named once, in
 * the form's order - what "Tarif applique : ..." names. Empty when no grid prices by category.
 */
export function appliedTierLabels(
  visible: readonly FormItem[],
  prices: ProductGridPrices | null | undefined
): string[] {
  const labels: string[] = [];
  for (const item of visible) {
    if (!isProductGrid(item)) continue;
    const viewer = prices?.[item.id];
    const label = viewer ? viewerTierLabel(viewer) : null;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * The sentence for a coded refusal of a priced grid's answer, or null for any other code.
 *
 * `PRODUCT_GRID_ANSWER_MISSING` is what an app that cannot draw the grid meets: this one can, so
 * meeting it means the page is older than the form - reloading is the cure. The cell refusals mean
 * the grid changed under the page (a cell closed, a row removed).
 */
export function productGridRefusalMessage(code: string | null): string | null {
  switch (code as ProductGridAnswerCode | null) {
    case 'PRODUCT_GRID_ANSWER_MISSING':
      return m.form_refusal_grid_update_app();
    case 'PRODUCT_GRID_UNKNOWN_CELL':
    case 'PRODUCT_GRID_QUANTITY_INVALID':
    case 'PRODUCT_GRID_CELL_CLOSED':
      return m.form_refusal_grid_changed();
    default:
      return null;
  }
}
