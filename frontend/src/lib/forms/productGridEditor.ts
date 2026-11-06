import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { Log } from '$lib/utils/Log';
import type { Dimension } from '$lib/pricing/priceMatrix';
import {
  PRODUCT_GRID_ALL_TIER,
  PRODUCT_GRID_LABEL_MAX,
  PRODUCT_GRID_MAX_COLUMNS,
  PRODUCT_GRID_MAX_PER_CELL,
  PRODUCT_GRID_MAX_ROWS,
  PRODUCT_GRID_MIN_PER_CELL,
  PRODUCT_GRID_OTHERS_TIER,
  PRODUCT_GRID_SINGLE_KEY,
  PRODUCT_GRID_TYPE,
  productGridAxisKeys,
  productGridCellKey,
  productGridItemRefusal,
  productGridLabelKey,
  productGridTierIds,
  type ProductGrid,
  type ProductGridAxisEntry,
  type ProductGridDefinitionCode,
  type ProductGridPriceMode,
  type ProductGridTiers,
} from './productGridContract';

/**
 * THE PRICED GRID AS THE EDITOR HOLDS IT (WP-G3), AND THE TWO TRIPS TO AND FROM THE WIRE.
 *
 * The stored shape is `productGridContract.ts`'s, the one the server judges. The editor's differs in
 * ONE way: prices are EUROS and may be blank (`null`) while the manager types - the inputs bind to
 * them - and the lists may hold keys of another mode or category, so switching the mode or the
 * criterion back does not lose what was typed. `productGridPayload` is the one place that turns
 * this into the contract's exact shape: cents, exactly one price per category x axis key, nothing
 * else. Validation runs on THAT shape, through the contract's own `productGridItemRefusal`, so the
 * editor refuses exactly what the save refuses.
 *
 * Every function here mutates the grid it is handed (a `$state` proxy in the component) and logs
 * the decision it took.
 */

/** A row or column axis. */
export type ProductGridAxis = 'rows' | 'columns';

/** The tier criterion a grid may price on: a profile criterion, never an answer. */
export type ProductGridTierDimension = Dimension & { kind: 'cotisation' | 'promo' | 'formation' };

/** A grid in the editor: the contract's shape, with euro prices that may be blank. */
export interface EditorProductGrid {
  rows: ProductGridAxisEntry[];
  columns: ProductGridAxisEntry[];
  maxPerCell: number;
  closedCells: string[];
  pricing: {
    mode: ProductGridPriceMode;
    tiers: ProductGridTierDimension | null;
    /** Category id -> axis key -> euros, or null while blank. May hold stale keys (see above). */
    prices: Record<string, Record<string, number | null>>;
  };
}

/** What a new grid allows per cell: a small stepper (the audit's default). */
export const PRODUCT_GRID_DEFAULT_MAX_PER_CELL = 5;

const TAG = 'productGridEditor';

/**
 * A fresh row, column or category id: a UUID, which the contract's id pattern accepts (a letter or
 * digit first, 36 characters). Renaming a label never changes it - answers and prices are keyed by it.
 */
export function newProductGridId(): string {
  return crypto.randomUUID();
}

/** A new grid: one blank row and one blank column, one price for everybody, 5 per cell. */
export function newProductGrid(): EditorProductGrid {
  return {
    rows: [{ id: newProductGridId(), label: '' }],
    columns: [{ id: newProductGridId(), label: '' }],
    maxPerCell: PRODUCT_GRID_DEFAULT_MAX_PER_CELL,
    closedCells: [],
    pricing: {
      mode: 'single',
      tiers: null,
      prices: { [PRODUCT_GRID_ALL_TIER]: { [PRODUCT_GRID_SINGLE_KEY]: null } },
    },
  };
}

/** The most entries an axis may hold (40 rows, 15 columns). */
export function axisMax(axis: ProductGridAxis): number {
  return axis === 'rows' ? PRODUCT_GRID_MAX_ROWS : PRODUCT_GRID_MAX_COLUMNS;
}

/** The categories the grid prices, in tab order: each bucket then "everyone else", or the one list. */
export function editorTierIds(grid: EditorProductGrid): string[] {
  return productGridTierIds({ tiers: grid.pricing.tiers as ProductGridTiers | null });
}

/** Every axis key the current mode prices: `*`, the row ids or the column ids. */
export function editorAxisKeys(grid: EditorProductGrid): string[] {
  return productGridAxisKeys(grid);
}

/** One price of one category, in euros, or null while blank. */
export function priceOf(grid: EditorProductGrid, tierId: string, axisKey: string): number | null {
  const value = grid.pricing.prices[tierId]?.[axisKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Sets one price; a blank or unreadable input stores null (the save then names it incomplete). */
export function setPrice(
  grid: EditorProductGrid,
  tierId: string,
  axisKey: string,
  euros: number | null
): void {
  const list = (grid.pricing.prices[tierId] ??= {});
  list[axisKey] = typeof euros === 'number' && Number.isFinite(euros) ? euros : null;
}

/**
 * The price a NEW axis key starts at, in one category's list: the single price if one was typed,
 * else the last price of the current mode - so a manager adding "XXL" to a per-column grid edits
 * only what differs - else any price of the list (a mode just switched). Null when it has none.
 */
function seedPrice(
  grid: EditorProductGrid,
  list: Record<string, number | null>,
  keys: string[]
): number | null {
  const single = list[PRODUCT_GRID_SINGLE_KEY];
  if (typeof single === 'number') return single;
  for (let i = keys.length - 1; i >= 0; i--) {
    const value = list[keys[i]];
    if (typeof value === 'number') return value;
  }
  // A mode just switched to: any price this category already had (a per-row list becoming one price).
  const any = Object.values(list).find((v): v is number => typeof v === 'number');
  if (any !== undefined) return any;
  Log.d(TAG, `no price to seed from in a list of ${Object.keys(list).length} keys`);
  return null;
}

/** Fills every missing price of the current mode, in every category, from that category's own list. */
function seedMissingPrices(grid: EditorProductGrid): void {
  const keys = editorAxisKeys(grid);
  for (const tierId of editorTierIds(grid)) {
    const list = (grid.pricing.prices[tierId] ??= {});
    const known = keys.filter((k) => typeof list[k] === 'number');
    for (const key of keys) {
      if (key in list && list[key] !== undefined) continue;
      list[key] = seedPrice(grid, list, known);
    }
  }
}

/** What adding labels did: how many joined, which were refused as already there, how many overflowed. */
export interface AddEntriesResult {
  added: number;
  duplicates: string[];
  overflow: number;
}

/**
 * Splits a pasted list into labels: one per line, commas and semicolons also split (a spreadsheet
 * column pasted, or "XS, S, M"), each trimmed, blanks dropped.
 */
export function splitPastedList(text: string): string[] {
  return text
    .split(/[\n\r,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Appends labels to an axis, in order, under fresh ids. A label already on the axis (or twice in
 * the list), compared as the save compares them (trimmed, case folded), is refused and named; past
 * the axis's maximum the rest is counted, never silently dropped. In a mode priced on this axis,
 * each new entry starts at its category's seed price.
 */
export function addAxisEntries(
  grid: EditorProductGrid,
  axis: ProductGridAxis,
  labels: readonly string[]
): AddEntriesResult {
  const list = grid[axis];
  const taken = new Set(list.map((e) => productGridLabelKey(e.label)).filter(Boolean));
  const result: AddEntriesResult = { added: 0, duplicates: [], overflow: 0 };
  for (const raw of labels) {
    const label = raw.trim();
    const key = productGridLabelKey(label);
    if (key && taken.has(key)) {
      result.duplicates.push(label);
      continue;
    }
    if (list.length >= axisMax(axis)) {
      result.overflow += 1;
      continue;
    }
    list.push({ id: newProductGridId(), label });
    if (key) taken.add(key);
    result.added += 1;
  }
  seedMissingPrices(grid);
  Log.d(
    TAG,
    `added ${result.added} ${axis} (${result.duplicates.length} duplicate, ${result.overflow} over the limit)`
  );
  return result;
}

/** Appends one blank entry, the "+" of an axis. False when the axis is full. */
export function addBlankEntry(grid: EditorProductGrid, axis: ProductGridAxis): boolean {
  if (grid[axis].length >= axisMax(axis)) {
    Log.d(TAG, `no blank ${axis} entry: the axis is full`);
    return false;
  }
  grid[axis].push({ id: newProductGridId(), label: '' });
  seedMissingPrices(grid);
  return true;
}

/**
 * Removes an entry, and with it every closed cell and every price it keyed. The last entry of an
 * axis is kept: a grid needs one row and one column, and the save would refuse an empty axis.
 */
export function removeAxisEntry(
  grid: EditorProductGrid,
  axis: ProductGridAxis,
  id: string
): boolean {
  if (grid[axis].length <= 1) {
    Log.d(TAG, `the last ${axis} entry is kept`);
    return false;
  }
  grid[axis] = grid[axis].filter((e) => e.id !== id);
  grid.closedCells = grid.closedCells.filter((key) => {
    const [rowId, colId] = key.split(':');
    return axis === 'rows' ? rowId !== id : colId !== id;
  });
  for (const list of Object.values(grid.pricing.prices)) delete list[id];
  Log.d(TAG, `removed one ${axis} entry`);
  return true;
}

/** Moves an entry from one position to another on its axis; out-of-range moves do nothing. */
export function moveAxisEntry(
  grid: EditorProductGrid,
  axis: ProductGridAxis,
  from: number,
  to: number
): boolean {
  const list = grid[axis];
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  grid[axis] = next;
  Log.d(TAG, `moved a ${axis} entry from ${from} to ${to}`);
  return true;
}

/** Whether a combination is closed ("no Creme in XS"). */
export function isCellClosed(grid: EditorProductGrid, rowId: string, colId: string): boolean {
  return grid.closedCells.includes(productGridCellKey(rowId, colId));
}

/**
 * Closes an open cell or reopens a closed one. Closing the LAST open cell is refused: the save
 * refuses a grid nobody can order from (`PRODUCT_GRID_ALL_CELLS_CLOSED`).
 */
export function toggleClosedCell(grid: EditorProductGrid, rowId: string, colId: string): boolean {
  const key = productGridCellKey(rowId, colId);
  if (grid.closedCells.includes(key)) {
    grid.closedCells = grid.closedCells.filter((k) => k !== key);
    Log.d(TAG, 'reopened one cell');
    return true;
  }
  if (grid.closedCells.length + 1 >= grid.rows.length * grid.columns.length) {
    Log.d(TAG, 'the last open cell stays open');
    return false;
  }
  grid.closedCells = [...grid.closedCells, key];
  Log.d(TAG, 'closed one cell');
  return true;
}

/** Sets the cap per cell, clamped to the contract's 1..99. */
export function setMaxPerCell(grid: EditorProductGrid, value: number): void {
  const n = Number.isFinite(value) ? Math.round(value) : PRODUCT_GRID_DEFAULT_MAX_PER_CELL;
  grid.maxPerCell = Math.min(PRODUCT_GRID_MAX_PER_CELL, Math.max(PRODUCT_GRID_MIN_PER_CELL, n));
}

/** Switches the price mode; prices the new mode lacks start from each category's seed. */
export function setPriceMode(grid: EditorProductGrid, mode: ProductGridPriceMode): void {
  if (grid.pricing.mode === mode) return;
  grid.pricing.mode = mode;
  seedMissingPrices(grid);
  Log.d(TAG, `price mode ${mode}`);
}

/**
 * Sets the tier criterion (null: one price for everybody). Every category the new criterion
 * prices that has no list yet starts as a copy of the list that was on screen - "everyone else"
 * when there was a criterion, the one list when there was not - so turning categories on changes
 * no price until the manager edits one.
 */
export function setTiers(grid: EditorProductGrid, tiers: ProductGridTierDimension | null): void {
  const source =
    grid.pricing.prices[grid.pricing.tiers ? PRODUCT_GRID_OTHERS_TIER : PRODUCT_GRID_ALL_TIER] ??
    {};
  grid.pricing.tiers = tiers;
  syncTierLists(grid, source);
  Log.d(TAG, tiers ? `priced per ${tiers.kind}, ${tiers.buckets.length} categories` : 'one price');
}

/**
 * Gives every category of the current criterion a price list - after a category is added in the
 * criterion editor, say - copied from `source` (default: "everyone else"). Lists of categories that
 * are gone stay in the editor and never reach the payload.
 */
export function syncTierLists(
  grid: EditorProductGrid,
  source: Record<string, number | null> = grid.pricing.prices[PRODUCT_GRID_OTHERS_TIER] ??
    grid.pricing.prices[PRODUCT_GRID_ALL_TIER] ??
    {}
): void {
  for (const tierId of editorTierIds(grid)) {
    if (!grid.pricing.prices[tierId]) grid.pricing.prices[tierId] = { ...source };
  }
  seedMissingPrices(grid);
}

/** U+20AC, built from its code point so this file stays ASCII. */
const EURO_SIGN = String.fromCharCode(0x20ac);

/**
 * A typed price, in euros: a comma or a dot as the decimal separator, spaces and a euro sign
 * ignored. Blank or unreadable is null - the inputs never guess a number nobody typed.
 */
export function parseEuroInput(text: string): number | null {
  // A no-break space (what a French locale writes) is matched by `\s`; the euro sign is dropped too.
  const cleaned = text.replace(/\s/g, '').split(EURO_SIGN).join('').replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** A price as its input shows it: blank when unset, the locale's decimal separator otherwise. */
export function euroInputText(euros: number | null): string {
  if (euros === null) return '';
  const text = String(Math.round(euros * 100) / 100);
  return getLocale() === 'en' ? text : text.replace('.', ',');
}

/** Euros typed to integer cents; null for a blank, a negative or an unreadable value. */
function toCents(euros: number | null | undefined): number | null {
  if (typeof euros !== 'number' || !Number.isFinite(euros) || euros < 0) return null;
  return Math.round(euros * 100);
}

/**
 * THE GRID AS THE WIRE CARRIES IT: the contract's shape, prices in cents, exactly the categories
 * and axis keys the mode and criterion name. A blank price is LEFT OUT, so the contract names the
 * list incomplete rather than the save charging 0 for a price nobody typed.
 */
export function productGridPayload(grid: EditorProductGrid): ProductGrid {
  const keys = editorAxisKeys(grid);
  const prices: Record<string, Record<string, number>> = {};
  for (const tierId of editorTierIds(grid)) {
    const list: Record<string, number> = {};
    for (const key of keys) {
      const cents = toCents(grid.pricing.prices[tierId]?.[key]);
      if (cents !== null) list[key] = cents;
    }
    prices[tierId] = list;
  }
  const live = new Set(
    grid.rows.flatMap((r) => grid.columns.map((c) => productGridCellKey(r.id, c.id)))
  );
  return {
    rows: grid.rows.map((r) => ({ id: r.id, label: r.label })),
    columns: grid.columns.map((c) => ({ id: c.id, label: c.label })),
    maxPerCell: grid.maxPerCell,
    closedCells: grid.closedCells.filter((k) => live.has(k)),
    pricing: {
      mode: grid.pricing.mode,
      tiers: grid.pricing.tiers
        ? (JSON.parse(JSON.stringify(grid.pricing.tiers)) as ProductGridTiers)
        : null,
      prices,
    },
  };
}

/** The stored grid back into the editor: cents to euros. A missing or broken grid starts fresh. */
export function editorProductGrid(stored: unknown): EditorProductGrid {
  const grid = stored as Partial<ProductGrid> | null | undefined;
  if (!grid || !Array.isArray(grid.rows) || !Array.isArray(grid.columns) || !grid.pricing) {
    Log.d(TAG, 'no stored grid to edit: a new one');
    return newProductGrid();
  }
  const prices: Record<string, Record<string, number | null>> = {};
  for (const [tierId, list] of Object.entries(grid.pricing.prices ?? {})) {
    prices[tierId] = Object.fromEntries(
      Object.entries(list ?? {}).map(([key, cents]) => [
        key,
        typeof cents === 'number' ? cents / 100 : null,
      ])
    );
  }
  return {
    rows: grid.rows.map((r) => ({ id: r.id, label: r.label })),
    columns: grid.columns.map((c) => ({ id: c.id, label: c.label })),
    maxPerCell: grid.maxPerCell ?? PRODUCT_GRID_DEFAULT_MAX_PER_CELL,
    closedCells: [...(grid.closedCells ?? [])],
    pricing: {
      mode: grid.pricing.mode ?? 'single',
      tiers: (grid.pricing.tiers as ProductGridTierDimension | null) ?? null,
      prices,
    },
  };
}

/**
 * A grid with FRESH row and column ids, for a duplicated question: the closed cells and the price
 * keys follow their entries to the new ids. Category ids are the criterion's own and stay. The
 * argument is not touched.
 */
export function withFreshProductGridIds<G extends EditorProductGrid | ProductGrid>(grid: G): G {
  const copy = JSON.parse(JSON.stringify(grid)) as G;
  const ids = new Map<string, string>();
  for (const entry of [...copy.rows, ...copy.columns]) {
    const next = newProductGridId();
    ids.set(entry.id, next);
    entry.id = next;
  }
  copy.closedCells = copy.closedCells
    .map((key) => {
      const [rowId, colId] = key.split(':');
      const r = ids.get(rowId);
      const c = ids.get(colId);
      return r && c ? productGridCellKey(r, c) : null;
    })
    .filter((k): k is string => k !== null);
  const prices = copy.pricing.prices as Record<string, Record<string, unknown>>;
  for (const tierId of Object.keys(prices)) {
    prices[tierId] = Object.fromEntries(
      Object.entries(prices[tierId]).map(([key, value]) => [ids.get(key) ?? key, value])
    );
  }
  Log.d(TAG, `fresh ids for ${ids.size} rows and columns`);
  return copy;
}

/**
 * The sentence for a grid definition's refusal code - the editor's own check and the server's
 * coded 400 read the same words. Null for a code that is not a grid definition's.
 */
export function productGridDefinitionMessage(code: string | null): string | null {
  switch (code as ProductGridDefinitionCode) {
    case 'PRODUCT_GRID_DEFINITION_MISSING':
    case 'PRODUCT_GRID_AXIS_INVALID':
    case 'PRODUCT_GRID_ID_INVALID':
    case 'PRODUCT_GRID_DUPLICATE_ID':
    case 'PRODUCT_GRID_CLOSED_CELL_INVALID':
    case 'PRODUCT_GRID_PRICE_MODE_INVALID':
      return m.form_pgrid_refusal_definition();
    case 'PRODUCT_GRID_NOT_REQUIRED':
      return m.form_pgrid_refusal_not_required();
    case 'PRODUCT_GRID_REQUIRES_PAYMENT':
      return m.form_pgrid_refusal_requires_payment();
    case 'PRODUCT_GRID_LABEL_INVALID':
      return m.form_pgrid_refusal_label({ max: PRODUCT_GRID_LABEL_MAX });
    case 'PRODUCT_GRID_DUPLICATE_LABEL':
      return m.form_pgrid_refusal_duplicate_label();
    case 'PRODUCT_GRID_MAX_PER_CELL_INVALID':
      return m.form_pgrid_refusal_max_per_cell({
        min: PRODUCT_GRID_MIN_PER_CELL,
        max: PRODUCT_GRID_MAX_PER_CELL,
      });
    case 'PRODUCT_GRID_ALL_CELLS_CLOSED':
      return m.form_pgrid_refusal_all_closed();
    case 'PRODUCT_GRID_TIER_INVALID':
      return m.form_pgrid_refusal_tier();
    case 'PRODUCT_GRID_GUEST_PRICE_MISSING':
      return m.form_pgrid_refusal_guest_price();
    case 'PRODUCT_GRID_PRICES_INCOMPLETE':
      return m.form_pgrid_refusal_prices_incomplete();
    case 'PRODUCT_GRID_PRICE_INVALID':
      return m.form_pgrid_refusal_price_invalid();
    default:
      return null;
  }
}

/** The form a grid is judged in: the two settings the contract reads. */
export interface ProductGridFormContext {
  isPublic: boolean;
  requiresPayment: boolean;
}

/** Why one editor question would be refused at save, as its code, or null. */
export function productGridItemProblem(
  item: { type?: string; required?: unknown; productGrid?: EditorProductGrid },
  form: ProductGridFormContext
): ProductGridDefinitionCode | null {
  if (item.type !== PRODUCT_GRID_TYPE) return null;
  const payload = item.productGrid ? productGridPayload(item.productGrid) : undefined;
  return (
    productGridItemRefusal({ required: item.required, productGrid: payload }, form)?.code ?? null
  );
}

/**
 * The first priced grid the save would refuse, with the sentence the page shows - judged by the
 * contract's `productGridItemRefusal` on the payload `productGridPayload` builds, so the page refuses
 * before the server does and in the same words.
 */
export function firstProductGridProblem(
  items: readonly {
    id: string;
    label?: string;
    type?: string;
    required?: unknown;
    productGrid?: EditorProductGrid;
  }[],
  form: ProductGridFormContext
): { itemId: string; message: string } | null {
  for (const item of items) {
    const code = productGridItemProblem(item, form);
    if (!code) continue;
    Log.d(TAG, `question ${item.id} refused before the save: ${code}`);
    return {
      itemId: item.id,
      message: m.form_pgrid_problem_in_question({
        label: item.label?.trim() || m.form_builder_title_placeholder(),
        problem: productGridDefinitionMessage(code) ?? m.form_pgrid_refusal_definition(),
      }),
    };
  }
  return null;
}

/**
 * The cells that already have orders, per grid question: what the edit page reads off the form's
 * answers so removing a row or column that was ordered can warn first. An answer of a grid is a
 * map of numbers (`"rowId:colId" -> quantity`); a zero is no order.
 */
export function orderedProductGridCells(
  submissions: readonly { answers?: Record<string, unknown> | null }[],
  gridIds: readonly string[]
): Record<string, string[]> {
  const ordered: Record<string, Set<string>> = {};
  for (const submission of submissions) {
    for (const id of gridIds) {
      const answer = submission.answers?.[id];
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
      for (const [key, quantity] of Object.entries(answer)) {
        if (typeof quantity === 'number' && quantity > 0) (ordered[id] ??= new Set()).add(key);
      }
    }
  }
  return Object.fromEntries(Object.entries(ordered).map(([id, keys]) => [id, [...keys]]));
}

/** Whether a row or column appears in one of the ordered cells. */
export function axisEntryHasOrders(
  orderedCells: readonly string[],
  axis: ProductGridAxis,
  id: string
): boolean {
  return orderedCells.some((key) => {
    const [rowId, colId] = key.split(':');
    return axis === 'rows' ? rowId === id : colId === id;
  });
}

/**
 * The registration price grid's profile criterion (cotisation, promo or formation), which a priced
 * grid may copy in one click so both price on the same categories - or null when the form takes no
 * payment, has no such criterion, or its criterion has no category yet.
 */
export function profileTierCriterion(
  matrix: { dimensions: Dimension[] } | null,
  requiresPayment: boolean
): ProductGridTierDimension | null {
  if (!requiresPayment || !matrix) return null;
  const found = matrix.dimensions.find((d) => d.kind !== 'answer' && d.buckets.length > 0);
  return (found as ProductGridTierDimension | undefined) ?? null;
}

/**
 * The label keys (`productGridLabelKey`) that occur more than once on one axis - the collision the
 * save refuses as `PRODUCT_GRID_DUPLICATE_LABEL`, marked on the field while it is typed. Blank
 * labels are another refusal and are not counted here.
 */
export function collidingLabelKeys(entries: readonly ProductGridAxisEntry[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const entry of entries) {
    const key = productGridLabelKey(entry.label);
    if (!key) continue;
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return twice;
}
