/**
 * THE PRICED GRID (`product_grid`): ITS SHAPE, ITS REFUSAL CODES AND ITS ARITHMETIC - ONE CONTRACT.
 *
 * A question of type `product_grid` is an order: rows x columns ("Vert" x "M"), each cell a
 * quantity from 0 to `maxPerCell`, each unit charged at the price the grid gives the payer's
 * category (owner, 2026-11-06; design in `docs/wiki/forms-capability-audit-2026-11-06.md`, section
 * 4, and the mechanism in `docs/wiki/frontend/modules/forms.md`, "The priced grid").
 *
 * THIS FILE IS COPIED, BYTE FOR BYTE, between social-service and the frontend, and the copy is
 * declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses the two drifting
 * apart. It is copied rather than shared because there is no TS library between `frontend/` and
 * `apps/` (`answer-text.ts`, `form-option-rules.ts`: the same arrangement). It imports nothing.
 *
 * What lives here is what BOTH sides must read the same way: the stored shape, the codes a refusal
 * carries (the client words each through Paraglide, the server never reads its own sentence back),
 * the structural rule a grid definition obeys, the rule an answer obeys, and how a quantity becomes
 * a priced line. What does NOT live here: which category a person is in (the server resolves it
 * from the profile, `pricing/audience.ts`, and hands the page its prices), and the deep check of a
 * category criterion (tiers the association sells, promo years - `pricing/validate.ts`).
 *
 * THE SERVER CHARGES WHAT IT COMPUTES. A client total built with `productGridLines` is a display;
 * `FormsService.submit` recomputes every line from the stored grid and never reads an amount sent.
 */

/** One row or one column: a stable id (answers and prices are keyed by it) and what people read. */
export interface ProductGridAxisEntry {
  id: string;
  label: string;
}

/**
 * Where a price varies: one price for every cell (`single`, axis key `*`), one per row (`per_row`,
 * axis key = the row id) or one per column (`per_column`, axis key = the column id). No row + column
 * surcharge (owner, 2026-11-06): a cell's price is ONE number read from ONE axis.
 */
export type ProductGridPriceMode = 'single' | 'per_row' | 'per_column';

/** One category of a tier criterion. The fields past `label` are the criterion's own (as stored). */
export interface ProductGridTierBucket {
  id: string;
  label: string;
  anyTier?: boolean;
  variantKeys?: (string | null)[];
  values?: (string | number)[];
}

/**
 * The ONE criterion a grid's prices may vary on: who the person is (a cotisation, a promo, a
 * formation) - never an answer. The same document as a form price grid's criterion, so the same
 * resolver places a person in exactly one category; a person in none, and every guest, is in
 * "everyone else" (`PRODUCT_GRID_OTHERS_TIER`).
 */
export interface ProductGridTiers {
  id: string;
  kind: 'cotisation' | 'promo' | 'formation';
  buckets: ProductGridTierBucket[];
}

/** The grid's prices: a complete list per category, in integer cents. */
export interface ProductGridPricing {
  mode: ProductGridPriceMode;
  /** Null: one price list for everybody, under `PRODUCT_GRID_ALL_TIER`. */
  tiers: ProductGridTiers | null;
  /** Category id -> axis key -> cents. Complete for every category and every axis key, >= 0. */
  prices: Record<string, Record<string, number>>;
}

/** What a `product_grid` question stores, under `item.productGrid`. */
export interface ProductGrid {
  rows: ProductGridAxisEntry[];
  columns: ProductGridAxisEntry[];
  /** 1 draws a checkbox, more a stepper. */
  maxPerCell: number;
  /** Combinations that do not exist ("no Creme in XS"), as `productGridCellKey`s. */
  closedCells: string[];
  pricing: ProductGridPricing;
}

/**
 * The grid as a RESPONDENT reads it: everything but the price lists, which come resolved for that
 * person alone (`ProductGridViewerPrices`) - nobody's page carries another category's prices.
 */
export interface ProductGridView extends Omit<ProductGrid, 'pricing'> {
  pricing: { mode: ProductGridPriceMode };
}

/** An answer: `"rowId:colId"` -> quantity. A cell left at 0 may be omitted. */
export type ProductGridAnswer = Record<string, number>;

/** The prices ONE viewer pays on one grid, resolved by the server from their profile. */
export interface ProductGridViewerPrices {
  /** The category id: a bucket's, `PRODUCT_GRID_OTHERS_TIER` or `PRODUCT_GRID_ALL_TIER`. */
  tierId: string;
  /** The bucket's label; null for "everyone else" and for a grid with one list (the client words it). */
  tierLabel: string | null;
  /** Axis key -> cents. */
  prices: Record<string, number>;
}

/** The read APIs' field: question id -> the viewer's prices on that grid. */
export type ProductGridPrices = Record<string, ProductGridViewerPrices>;

/**
 * One ordered cell, priced: what `submissions.lines` keeps of every answer (migration 137), so an
 * export says what was CHARGED even after the creator renames a row or moves a price.
 */
export interface ProductGridLine {
  itemId: string;
  itemLabel: string;
  rowId: string;
  rowLabel: string;
  colId: string;
  colLabel: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  tierId: string;
  tierLabel: string | null;
}

/** The question type. */
export const PRODUCT_GRID_TYPE = 'product_grid';
/** The category of a grid with no tier criterion: everybody. */
export const PRODUCT_GRID_ALL_TIER = '_all';
/** "Everyone else" - the same id as a price grid's generated group. Where every guest lands. */
export const PRODUCT_GRID_OTHERS_TIER = '_others';
/** The axis key of the `single` price mode. */
export const PRODUCT_GRID_SINGLE_KEY = '*';
/** The bounds of `maxPerCell`. */
export const PRODUCT_GRID_MIN_PER_CELL = 1;
export const PRODUCT_GRID_MAX_PER_CELL = 99;
/** At most this many rows and columns; the answers validator bounds an answer object by their product. */
export const PRODUCT_GRID_MAX_ROWS = 40;
export const PRODUCT_GRID_MAX_COLUMNS = 15;
/** A row or column label, at most this long once trimmed. */
export const PRODUCT_GRID_LABEL_MAX = 100;
/** A sanity bound on one unit price (10 000 EUR); the payable range is checked on the total. */
export const PRODUCT_GRID_MAX_PRICE_CENTS = 1_000_000;
/**
 * A row, column or category id: a letter or digit first (so never `_all`, `_others` or `__proto__`),
 * then letters, digits, `-` and `_`, 36 characters at most - a UUID fits. Never `:`, the cell key's
 * separator.
 */
export const PRODUCT_GRID_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/;

/** Why a grid DEFINITION is refused at save, one code per cause. */
export const PRODUCT_GRID_DEFINITION_CODES = [
  'PRODUCT_GRID_DEFINITION_MISSING',
  'PRODUCT_GRID_REQUIRES_PAYMENT',
  'PRODUCT_GRID_AXIS_INVALID',
  'PRODUCT_GRID_ID_INVALID',
  'PRODUCT_GRID_DUPLICATE_ID',
  'PRODUCT_GRID_LABEL_INVALID',
  'PRODUCT_GRID_DUPLICATE_LABEL',
  'PRODUCT_GRID_MAX_PER_CELL_INVALID',
  'PRODUCT_GRID_CLOSED_CELL_INVALID',
  'PRODUCT_GRID_ALL_CELLS_CLOSED',
  'PRODUCT_GRID_PRICE_MODE_INVALID',
  'PRODUCT_GRID_TIER_INVALID',
  'PRODUCT_GRID_GUEST_PRICE_MISSING',
  'PRODUCT_GRID_PRICES_INCOMPLETE',
  'PRODUCT_GRID_PRICE_INVALID',
] as const;
export type ProductGridDefinitionCode = (typeof PRODUCT_GRID_DEFINITION_CODES)[number];

/**
 * Why an ANSWER is refused at submit. `PRODUCT_GRID_ANSWER_MISSING` is the one an app that cannot
 * draw the grid meets (it sends a string, or a list): a client that knows this code says "update
 * the app". An ABSENT answer is an untouched grid, an empty order line - not this code. A REQUIRED
 * grid left empty is no code of a grid's: it is refused like every other required question
 * (`FORM_ANSWER_MISSING`, naming the grid), judged by {@link productGridOrdered}.
 */
export const PRODUCT_GRID_ANSWER_CODES = [
  'PRODUCT_GRID_ANSWER_MISSING',
  'PRODUCT_GRID_UNKNOWN_CELL',
  'PRODUCT_GRID_QUANTITY_INVALID',
  'PRODUCT_GRID_CELL_CLOSED',
] as const;
export type ProductGridAnswerCode = (typeof PRODUCT_GRID_ANSWER_CODES)[number];

/** A refusal: its code, and what it is about (an id, a key) for the log and the editor. */
export interface ProductGridRefusal<C extends string> {
  code: C;
  detail?: string;
}

/** The key of one cell, in answers and in `closedCells`. */
export function productGridCellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

/** The axis key a cell's price is read under, by the grid's price mode. */
export function productGridAxisKey(
  mode: ProductGridPriceMode,
  rowId: string,
  colId: string
): string {
  if (mode === 'per_row') return rowId;
  if (mode === 'per_column') return colId;
  return PRODUCT_GRID_SINGLE_KEY;
}

/** Every axis key a complete price list holds, in display order. */
export function productGridAxisKeys(
  grid: Pick<ProductGrid, 'rows' | 'columns'> & { pricing: { mode: ProductGridPriceMode } }
): string[] {
  if (grid.pricing.mode === 'per_row') return grid.rows.map((r) => r.id);
  if (grid.pricing.mode === 'per_column') return grid.columns.map((c) => c.id);
  return [PRODUCT_GRID_SINGLE_KEY];
}

/** Every category a complete grid prices: each bucket, then "everyone else"; or the one list. */
export function productGridTierIds(pricing: Pick<ProductGridPricing, 'tiers'>): string[] {
  if (!pricing.tiers) return [PRODUCT_GRID_ALL_TIER];
  return [...pricing.tiers.buckets.map((b) => b.id), PRODUCT_GRID_OTHERS_TIER];
}

/** The tier id a guest is charged under: "everyone else", or the one list. */
export function productGridGuestTier(pricing: Pick<ProductGridPricing, 'tiers'>): string {
  return pricing.tiers ? PRODUCT_GRID_OTHERS_TIER : PRODUCT_GRID_ALL_TIER;
}

function own(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The comparison two labels of one axis must not be equal under: trimmed, case folded. */
export function productGridLabelKey(label: string): string {
  return label.trim().toLowerCase();
}

function axisRefusal(
  raw: unknown,
  max: number
): ProductGridRefusal<ProductGridDefinitionCode> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    return { code: 'PRODUCT_GRID_AXIS_INVALID' };
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) return { code: 'PRODUCT_GRID_AXIS_INVALID' };
    const { id, label } = entry;
    if (typeof id !== 'string' || !PRODUCT_GRID_ID_PATTERN.test(id)) {
      return { code: 'PRODUCT_GRID_ID_INVALID', detail: String(id) };
    }
    if (ids.has(id)) return { code: 'PRODUCT_GRID_DUPLICATE_ID', detail: id };
    ids.add(id);
    if (
      typeof label !== 'string' ||
      label.trim() === '' ||
      label.trim().length > PRODUCT_GRID_LABEL_MAX
    ) {
      return { code: 'PRODUCT_GRID_LABEL_INVALID', detail: id };
    }
    const key = productGridLabelKey(label);
    if (labels.has(key)) return { code: 'PRODUCT_GRID_DUPLICATE_LABEL', detail: label.trim() };
    labels.add(key);
  }
  return null;
}

function tiersRefusal(raw: unknown): ProductGridRefusal<ProductGridDefinitionCode> | null {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return { code: 'PRODUCT_GRID_TIER_INVALID' };
  if (raw.kind !== 'cotisation' && raw.kind !== 'promo' && raw.kind !== 'formation') {
    return { code: 'PRODUCT_GRID_TIER_INVALID', detail: String(raw.kind) };
  }
  if (!Array.isArray(raw.buckets) || raw.buckets.length === 0) {
    return { code: 'PRODUCT_GRID_TIER_INVALID' };
  }
  const ids = new Set<string>();
  for (const bucket of raw.buckets as unknown[]) {
    const id = isPlainObject(bucket) ? bucket.id : undefined;
    if (typeof id !== 'string' || !PRODUCT_GRID_ID_PATTERN.test(id) || ids.has(id)) {
      return { code: 'PRODUCT_GRID_TIER_INVALID', detail: String(id) };
    }
    ids.add(id);
  }
  return null;
}

/**
 * The first reason a `product_grid` question cannot be saved, or null. Structural only: the tier
 * criterion's CONTENT (a tier the association sells, a real promo year, two categories that cannot
 * both hold one person) is the server's (`pricing/validate.ts`), which knows the association.
 *
 * `form.isPublic`: a guest pays "everyone else", so a public form's grid must price that category
 * (`PRODUCT_GRID_GUEST_PRICE_MISSING`, judged before completeness so the editor can name it).
 * `form.requiresPayment`: a grid charges, so the form takes payment.
 *
 * `required` is not judged here: it is the manager's "Obligatoire" switch, off by default (owner,
 * 2026-11-13), and {@link productGridRequiredOnSave} decides what is stored.
 */
export function productGridItemRefusal(
  item: { productGrid?: unknown },
  form: { isPublic: boolean; requiresPayment: boolean }
): ProductGridRefusal<ProductGridDefinitionCode> | null {
  const grid = item.productGrid;
  if (!isPlainObject(grid)) return { code: 'PRODUCT_GRID_DEFINITION_MISSING' };
  if (!form.requiresPayment) return { code: 'PRODUCT_GRID_REQUIRES_PAYMENT' };
  const axis =
    axisRefusal(grid.rows, PRODUCT_GRID_MAX_ROWS) ??
    axisRefusal(grid.columns, PRODUCT_GRID_MAX_COLUMNS);
  if (axis) return axis;
  const rows = grid.rows as ProductGridAxisEntry[];
  const columns = grid.columns as ProductGridAxisEntry[];
  const max = grid.maxPerCell;
  if (
    typeof max !== 'number' ||
    !Number.isInteger(max) ||
    max < PRODUCT_GRID_MIN_PER_CELL ||
    max > PRODUCT_GRID_MAX_PER_CELL
  ) {
    return { code: 'PRODUCT_GRID_MAX_PER_CELL_INVALID', detail: String(max) };
  }
  const cells = new Set(rows.flatMap((r) => columns.map((c) => productGridCellKey(r.id, c.id))));
  const closedRaw = grid.closedCells ?? [];
  if (!Array.isArray(closedRaw)) return { code: 'PRODUCT_GRID_CLOSED_CELL_INVALID' };
  const closed = new Set<string>();
  for (const key of closedRaw as unknown[]) {
    if (typeof key !== 'string' || !cells.has(key) || closed.has(key)) {
      return { code: 'PRODUCT_GRID_CLOSED_CELL_INVALID', detail: String(key) };
    }
    closed.add(key);
  }
  if (closed.size === cells.size) return { code: 'PRODUCT_GRID_ALL_CELLS_CLOSED' };

  const pricing = grid.pricing;
  if (!isPlainObject(pricing)) return { code: 'PRODUCT_GRID_PRICE_MODE_INVALID' };
  const mode = pricing.mode;
  if (mode !== 'single' && mode !== 'per_row' && mode !== 'per_column') {
    return { code: 'PRODUCT_GRID_PRICE_MODE_INVALID', detail: String(mode) };
  }
  const tiers = pricing.tiers === undefined ? null : pricing.tiers;
  const tierRefusal = tiersRefusal(tiers);
  if (tierRefusal) return tierRefusal;
  const prices = pricing.prices;
  if (!isPlainObject(prices)) return { code: 'PRODUCT_GRID_PRICES_INCOMPLETE' };

  const tierIds = productGridTierIds({ tiers: tiers as ProductGridTiers | null });
  const axisKeys = productGridAxisKeys({ rows, columns, pricing: { mode } });
  const guestTier = productGridGuestTier({ tiers: tiers as ProductGridTiers | null });
  const complete = (tierId: string): boolean => {
    if (!own(prices, tierId) || !isPlainObject(prices[tierId])) return false;
    const list = prices[tierId] as Record<string, unknown>;
    return axisKeys.every((key) => own(list, key));
  };
  if (form.isPublic && !complete(guestTier)) {
    return { code: 'PRODUCT_GRID_GUEST_PRICE_MISSING', detail: guestTier };
  }
  for (const tierId of tierIds) {
    if (!complete(tierId)) return { code: 'PRODUCT_GRID_PRICES_INCOMPLETE', detail: tierId };
  }
  const extraTier = Object.keys(prices).find((id) => !tierIds.includes(id));
  if (extraTier !== undefined) {
    return { code: 'PRODUCT_GRID_PRICES_INCOMPLETE', detail: extraTier };
  }
  for (const tierId of tierIds) {
    const list = prices[tierId] as Record<string, unknown>;
    const extraKey = Object.keys(list).find((key) => !axisKeys.includes(key));
    if (extraKey !== undefined) {
      return { code: 'PRODUCT_GRID_PRICES_INCOMPLETE', detail: `${tierId}/${extraKey}` };
    }
    for (const key of axisKeys) {
      const cents = list[key];
      if (
        typeof cents !== 'number' ||
        !Number.isInteger(cents) ||
        cents < 0 ||
        cents > PRODUCT_GRID_MAX_PRICE_CENTS
      ) {
        return { code: 'PRODUCT_GRID_PRICE_INVALID', detail: `${tierId}/${key}` };
      }
    }
  }
  return null;
}

/**
 * Whether a grid's answer orders at least ONE unit - what a REQUIRED grid demands (owner,
 * 2026-11-13: the minimum is one unit, no configurable number), and the one predicate the fill page
 * (`isItemAnswered`) and the submit (`FormsService.submit`) both read. Lenient on purpose: a value
 * that is not an order holds no unit, and whether it is a VALID order is
 * {@link parseProductGridAnswer}'s question.
 */
export function productGridOrdered(answer: unknown): boolean {
  if (!isPlainObject(answer)) return false;
  return Object.values(answer).some((value) => typeof value === 'number' && value > 0);
}

/**
 * The `required` a grid sent for saving is STORED with - its "Obligatoire" switch (owner,
 * 2026-11-13), off by default.
 *
 * `chosen`: the save comes from an editor that draws the switch (the form payload's
 * `gridRequiredSwitch`), so the flag sent IS the manager's choice. Without it the save comes from an
 * editor older than the switch, which sends `required: true` on EVERY grid whatever it means
 * ([LEGACY], docs/wiki/legacy-compatibility.md): that flag says nothing, so the grid keeps the flag
 * stored under its id, and a grid not stored yet is optional - an old editor never makes a grid
 * required by surprise, nor drops a choice a newer one made.
 */
export function productGridRequiredOnSave(
  item: { id?: unknown; required?: unknown },
  chosen: boolean,
  stored: readonly { id?: unknown; type?: unknown; required?: unknown }[] | null | undefined
): boolean {
  if (chosen) return item.required === true;
  const before = (stored ?? []).find((s) => s.id === item.id && s.type === PRODUCT_GRID_TYPE);
  return before?.required === true;
}

/** An answer judged against its grid: the quantities ordered, or why it is refused. */
export type ProductGridAnswerResult =
  | { ok: true; answer: ProductGridAnswer; units: number }
  | ({ ok: false } & ProductGridRefusal<ProductGridAnswerCode>);

/**
 * Judges ONE grid's answer: every key a declared cell, every value an integer from 0 to
 * `maxPerCell`, no unit in a closed cell. An absent answer (`undefined`, `null`) and `{}` are an
 * untouched grid: accepted, 0 units. Whether a REQUIRED grid holds a unit is the caller's question
 * ({@link productGridOrdered}). The answer returned
 * keeps the ordered cells only, in the grid's row-then-column order - what is stored.
 */
export function parseProductGridAnswer(
  grid: Pick<ProductGrid, 'rows' | 'columns' | 'maxPerCell' | 'closedCells'>,
  raw: unknown
): ProductGridAnswerResult {
  if (raw === undefined || raw === null) return { ok: true, answer: {}, units: 0 };
  if (!isPlainObject(raw)) return { ok: false, code: 'PRODUCT_GRID_ANSWER_MISSING' };
  const cells = grid.rows.flatMap((r) => grid.columns.map((c) => productGridCellKey(r.id, c.id)));
  const declared = new Set(cells);
  const closed = new Set(grid.closedCells ?? []);
  for (const [key, value] of Object.entries(raw)) {
    if (!declared.has(key)) return { ok: false, code: 'PRODUCT_GRID_UNKNOWN_CELL', detail: key };
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > grid.maxPerCell
    ) {
      return { ok: false, code: 'PRODUCT_GRID_QUANTITY_INVALID', detail: key };
    }
    if (value > 0 && closed.has(key)) {
      return { ok: false, code: 'PRODUCT_GRID_CELL_CLOSED', detail: key };
    }
  }
  const answer: ProductGridAnswer = {};
  let units = 0;
  for (const key of cells) {
    const quantity = own(raw, key) ? (raw[key] as number) : 0;
    if (quantity === 0) continue;
    answer[key] = quantity;
    units += quantity;
  }
  return { ok: true, answer, units };
}

/**
 * The priced lines of an answer already judged (`parseProductGridAnswer`), in the grid's order, at
 * the prices of ONE category. A price missing from the list is a grid that broke the save-time
 * completeness rule: it THROWS rather than charge a unit at 0.
 */
export function productGridLines(
  item: {
    id: string;
    label: string;
    productGrid: Pick<ProductGrid, 'rows' | 'columns'> & {
      pricing: { mode: ProductGridPriceMode };
    };
  },
  answer: ProductGridAnswer,
  viewer: ProductGridViewerPrices
): ProductGridLine[] {
  const grid = item.productGrid;
  const lines: ProductGridLine[] = [];
  for (const row of grid.rows) {
    for (const col of grid.columns) {
      const key = productGridCellKey(row.id, col.id);
      const quantity = own(answer, key) ? answer[key] : 0;
      if (!quantity) continue;
      const axisKey = productGridAxisKey(grid.pricing.mode, row.id, col.id);
      if (!own(viewer.prices, axisKey)) {
        throw new Error(
          `product grid ${item.id}: no price for "${axisKey}" in category ${viewer.tierId}`
        );
      }
      const unitCents = viewer.prices[axisKey];
      lines.push({
        itemId: item.id,
        itemLabel: item.label,
        rowId: row.id,
        rowLabel: row.label.trim(),
        colId: col.id,
        colLabel: col.label.trim(),
        quantity,
        unitCents,
        lineCents: unitCents * quantity,
        tierId: viewer.tierId,
        tierLabel: viewer.tierLabel,
      });
    }
  }
  return lines;
}

/** The sum of some lines, in cents. */
export function productGridTotalCents(lines: readonly ProductGridLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineCents, 0);
}

/** The grid as a respondent may read it: the price lists removed, the mode kept. */
export function productGridView(grid: ProductGrid): ProductGridView {
  return {
    rows: grid.rows,
    columns: grid.columns,
    maxPerCell: grid.maxPerCell,
    closedCells: grid.closedCells,
    pricing: { mode: grid.pricing.mode },
  };
}

/**
 * WHICH ANSWERS THE TOTALS COUNT - ONE RULE for the export's "Totaux" sheet and the responses
 * screen's "Totaux" tab (owner, 2026-11-06). Units are counted as ordered when the money landed or
 * nothing was owed (`paid`, `free`); an order placed in cash whose money is not received yet
 * (`pending_cash`) is counted apart, and the screen's switch adds it or leaves it out. A refunded,
 * cancelled, expired or still-pending online answer is never counted: no status outside these two
 * lists ever reaches a total.
 */
export const PRODUCT_GRID_RECEIVED_STATUSES: readonly string[] = ['paid', 'free'];
/** Ordered in cash, the money not yet received: counted apart, or added by the screen's switch. */
export const PRODUCT_GRID_AWAITING_CASH_STATUSES: readonly string[] = ['pending_cash'];

/** The lines of the answers whose status is in `statuses`, in the answers' order. */
export function productGridLinesOf(
  submissions: readonly { paymentStatus: string; lines?: readonly ProductGridLine[] | null }[],
  statuses: readonly string[]
): ProductGridLine[] {
  const wanted = new Set(statuses);
  return submissions
    .filter((sub) => wanted.has(sub.paymentStatus))
    .flatMap((sub) => (sub.lines ? [...sub.lines] : []));
}

/** Units and cents of one row, one column, or the whole grid. */
export interface ProductGridSum {
  units: number;
  cents: number;
}

/** One grid's totals over a set of lines: per cell, per row, per column, and in all. */
export interface ProductGridTotals {
  /** The grid's rows as they stand, then any row the lines name that the grid no longer has. */
  rows: ProductGridAxisEntry[];
  /** The same for the columns. */
  columns: ProductGridAxisEntry[];
  /** `productGridCellKey` -> units and cents. A cell nobody ordered is absent. */
  cells: Record<string, ProductGridSum>;
  /** Row id -> its sum. Every listed row is present. */
  rowTotals: Record<string, ProductGridSum>;
  /** Column id -> its sum. Every listed column is present. */
  columnTotals: Record<string, ProductGridSum>;
  /** The grid's sum. */
  total: ProductGridSum;
}

/**
 * An axis as the totals list it: the grid's entries as they stand, then any entry the lines name
 * that the grid no longer has (a deleted row keeps its past orders), under the label it was charged
 * with.
 */
function axisWithPast(
  current: readonly ProductGridAxisEntry[],
  lines: readonly ProductGridLine[],
  pick: (line: ProductGridLine) => ProductGridAxisEntry
): ProductGridAxisEntry[] {
  const axis = current.map((entry) => ({ id: entry.id, label: entry.label }));
  const known = new Set(axis.map((entry) => entry.id));
  for (const line of lines) {
    const entry = pick(line);
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    axis.push(entry);
  }
  return axis;
}

/**
 * Sums the lines of ONE grid question - its own, `itemId` matched - into its totals. Reads what was
 * CHARGED (`submissions.lines`), never the grid's current prices.
 */
export function productGridTotals(
  item: { id: string; productGrid: Pick<ProductGrid, 'rows' | 'columns'> },
  lines: readonly ProductGridLine[]
): ProductGridTotals {
  const ownLines = lines.filter((line) => line.itemId === item.id);
  const rows = axisWithPast(item.productGrid.rows, ownLines, (l) => ({
    id: l.rowId,
    label: l.rowLabel,
  }));
  const columns = axisWithPast(item.productGrid.columns, ownLines, (l) => ({
    id: l.colId,
    label: l.colLabel,
  }));
  const zero = (): ProductGridSum => ({ units: 0, cents: 0 });
  const cells: Record<string, ProductGridSum> = {};
  const rowTotals: Record<string, ProductGridSum> = {};
  const columnTotals: Record<string, ProductGridSum> = {};
  for (const row of rows) rowTotals[row.id] = zero();
  for (const col of columns) columnTotals[col.id] = zero();
  const total = zero();
  for (const line of ownLines) {
    const key = productGridCellKey(line.rowId, line.colId);
    const cell = own(cells, key) ? cells[key] : (cells[key] = zero());
    for (const sum of [cell, rowTotals[line.rowId], columnTotals[line.colId], total]) {
      sum.units += line.quantity;
      sum.cents += line.lineCents;
    }
  }
  return { rows, columns, cells, rowTotals, columnTotals, total };
}
