/**
 * The pricing grid, as the editor holds it.
 *
 * The shapes mirror the server's `forms/pricing/` exactly, because the server is the authority on
 * what a price is - this module never decides a price, it only edits the document and keeps it
 * COMPLETE while the manager works. Completeness is a save-time invariant server-side, so an editor
 * that let a cell go missing would produce a save that fails with a message about cell keys.
 *
 * Prices are in EUROS here, because that is what the inputs bind to. The one conversion to cents
 * happens in `matrixPayload`.
 */

/** The generated group every criterion ends with. Never stored, never editable, always last. */
export const OTHERS_BUCKET_ID = '_others';

/** The four things a form can discriminate on. */
export type DimensionKind = 'cotisation' | 'promo' | 'formation' | 'answer';

export interface Bucket {
  id: string;
  label: string;
  /** Cotisation: any tier the association sells, now or later. */
  anyTier?: boolean;
  /** Cotisation: specific tiers; `null` is the base tier. */
  variantKeys?: (string | null)[];
  /** Promo: years. Formation: values. Answer: option ids. */
  values?: (string | number)[];
}

export interface Dimension {
  id: string;
  kind: DimensionKind;
  /** `answer` only. */
  questionId?: string;
  buckets: Bucket[];
}

/**
 * One cell: a price in euros, or `null` for a combination that DOES NOT EXIST.
 *
 * `null` is not zero and not a missing cell. It is the manager saying nobody in that situation may
 * answer at all, which no number can say - 0 means free. The grid stays COMPLETE either way, so the
 * "exactly one cell applies, no priority rule" invariant is untouched; what changes is that a cell
 * may refuse instead of charging.
 */
export type CellValue = number | null;

export interface PriceMatrix {
  dimensions: Dimension[];
  /** Euros in the editor, keyed by the bucket ids joined in dimension order. */
  cells: Record<string, CellValue>;
}

let counter = 0;
/** Short unique id. Only ever used inside one document, so a counter plus a prefix is enough. */
function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The bucket ids of one criterion, in key order - the declared ones, then the generated last. */
export function bucketIds(dimension: Dimension): string[] {
  return [...dimension.buckets.map((b) => b.id), OTHERS_BUCKET_ID];
}

/** One cell key: bucket ids in dimension order. */
export function cellKey(ids: string[]): string {
  return ids.join('|');
}

/** Every key a complete grid must carry, in a stable order. Mirrors the server's `allCellKeys`. */
export function allCellKeys(dimensions: Dimension[]): string[] {
  return dimensions.reduce<string[]>(
    (keys, d) =>
      keys.flatMap((prefix) => bucketIds(d).map((id) => (prefix ? `${prefix}|${id}` : id))),
    ['']
  );
}

/**
 * Whether a key carries a DECISION - a price, or an explicit "this does not exist".
 *
 * Distinct from truthiness and from `!= null` on purpose: 0 is a price and `null` is an answer, so
 * only an absent key is a hole in the grid.
 */
export function hasCell(cells: Record<string, CellValue>, key: string): boolean {
  return cells[key] === null || typeof cells[key] === 'number';
}

/** The value at a key, or free when there is none - what an inherited cell starts from. */
function valueAt(cells: Record<string, CellValue>, key: string): CellValue {
  return hasCell(cells, key) ? cells[key] : 0;
}

/** Whether every combination has been decided. What the server checks, checked here first. */
export function isComplete(matrix: PriceMatrix): boolean {
  return allCellKeys(matrix.dimensions).every((k) => hasCell(matrix.cells, k));
}

/** A grid switched on but not yet divided: the editor then asks for the first criterion. */
export function emptyMatrix(basePrice: number): PriceMatrix {
  return { dimensions: [], cells: { '': basePrice } };
}

/**
 * Adds a criterion, keeping every existing price.
 *
 * A new criterion multiplies the grid, and each new cell inherits the price of the cell it came
 * from - so switching on "filtrer par formation" changes nothing anybody pays until a group's price
 * is actually edited. Turning a criterion on must not silently reprice a form.
 */
export function addDimension(matrix: PriceMatrix, dimension: Dimension): PriceMatrix {
  const dimensions = [...matrix.dimensions, dimension];
  const cells: Record<string, CellValue> = {};
  const previous = matrix.dimensions.length === 0 ? [''] : allCellKeys(matrix.dimensions);
  for (const prefix of previous) {
    const inherited = valueAt(matrix.cells, prefix);
    for (const id of bucketIds(dimension)) {
      cells[prefix ? `${prefix}|${id}` : id] = inherited;
    }
  }
  return { dimensions, cells };
}

/**
 * Removes a criterion, keeping the price that applied to the most people.
 *
 * The surviving value is taken from the removed criterion's "everyone else" column, because that is
 * what the criterion was distinguishing FROM - keeping a group's special price instead would apply
 * a discount to everybody, which is the expensive direction to be wrong in.
 */
export function removeDimension(matrix: PriceMatrix, dimensionId: string): PriceMatrix {
  const index = matrix.dimensions.findIndex((d) => d.id === dimensionId);
  if (index === -1) return matrix;
  const dimensions = matrix.dimensions.filter((d) => d.id !== dimensionId);
  const cells: Record<string, CellValue> = {};
  for (const key of allCellKeys(dimensions)) {
    const parts = key === '' ? [] : key.split('|');
    const full = [...parts.slice(0, index), OTHERS_BUCKET_ID, ...parts.slice(index)];
    cells[key] = valueAt(matrix.cells, cellKey(full));
  }
  return { dimensions, cells };
}

/**
 * Adds a group to a criterion. Its cells start from the "everyone else" column, which is where the
 * people it now describes were priced a moment ago.
 */
export function addBucket(matrix: PriceMatrix, dimensionId: string, bucket: Bucket): PriceMatrix {
  const index = matrix.dimensions.findIndex((d) => d.id === dimensionId);
  if (index === -1) return matrix;
  const dimensions = matrix.dimensions.map((d) =>
    d.id === dimensionId ? { ...d, buckets: [...d.buckets, bucket] } : d
  );
  const cells = { ...matrix.cells };
  for (const key of allCellKeys(dimensions)) {
    if (hasCell(cells, key)) continue;
    const parts = key.split('|');
    if (parts[index] !== bucket.id) continue;
    const from = [...parts];
    from[index] = OTHERS_BUCKET_ID;
    cells[key] = valueAt(matrix.cells, cellKey(from));
  }
  return { dimensions, cells };
}

/** Removes a group and the cells that named it. */
export function removeBucket(
  matrix: PriceMatrix,
  dimensionId: string,
  bucketId: string
): PriceMatrix {
  const dimensions = matrix.dimensions.map((d) =>
    d.id === dimensionId ? { ...d, buckets: d.buckets.filter((b) => b.id !== bucketId) } : d
  );
  const kept = new Set(allCellKeys(dimensions));
  const cells: Record<string, CellValue> = {};
  for (const key of kept) cells[key] = valueAt(matrix.cells, key);
  return { dimensions, cells };
}

/** A fresh criterion of the given kind, with one empty group ready to name. */
export function newDimension(kind: DimensionKind, opts: { questionId?: string } = {}): Dimension {
  return {
    id: makeId('d'),
    kind,
    ...(kind === 'answer' ? { questionId: opts.questionId } : {}),
    buckets: [],
  };
}

/** A fresh group for a criterion of the given kind. */
export function newBucket(kind: DimensionKind, label: string): Bucket {
  const base = { id: makeId('b'), label };
  if (kind === 'cotisation') return { ...base, anyTier: true };
  return { ...base, values: [] };
}

/**
 * The most criteria the editor lets a manager ADD (owner, 2026-11-06): two is a table a person can
 * read, rows by columns, and a third turned it into a list of combinations nobody could scan. A
 * stored grid with more still loads, lays out and saves - the server has no such bound, and an
 * existing form must open unchanged.
 */
export const MAX_CRITERIA = 2;

/**
 * One row or one column of the price table: the bucket ids it contributes to a cell key, in
 * dimension order, and the group labels they carry (`''` for "everyone else").
 */
export interface GridLine {
  /** The ids joined - stable across renders, so it is the line's identity. */
  key: string;
  ids: string[];
  labels: string[];
}

/**
 * How the grid is laid out: a TRUE table, the first criterion down the side and the second across
 * the top, so a cell is read where a row meets a column.
 *
 * One criterion gives one row per group and a single price column (`ids` empty). A stored grid with
 * more than two criteria - no longer offered, still loadable - nests all but the last down the side,
 * so every cell is still exactly one row by one column.
 */
export function gridAxes(matrix: PriceMatrix): { rows: GridLine[]; columns: GridLine[] } {
  const { dimensions } = matrix;
  if (dimensions.length === 0) return { rows: [], columns: [] };
  const lines = (dims: Dimension[]): GridLine[] =>
    dims
      .reduce<{ ids: string[]; labels: string[] }[]>(
        (acc, d) =>
          acc.flatMap((line) =>
            bucketIds(d).map((id) => ({
              ids: [...line.ids, id],
              labels: [...line.labels, d.buckets.find((b) => b.id === id)?.label ?? ''],
            }))
          ),
        [{ ids: [], labels: [] }]
      )
      .map((line) => ({ ...line, key: cellKey(line.ids) }));
  if (dimensions.length === 1) return { rows: lines(dimensions), columns: lines([]) };
  return { rows: lines(dimensions.slice(0, -1)), columns: lines(dimensions.slice(-1)) };
}

/** The cell key where a row meets a column. */
export function crossKey(row: GridLine, column: GridLine): string {
  return cellKey([...row.ids, ...column.ids]);
}

/** Every cell key of one row or one column - what a header selection fills or closes at once. */
export function lineCellKeys(
  axes: { rows: GridLine[]; columns: GridLine[] },
  axis: 'row' | 'column',
  lineKey: string
): string[] {
  if (axis === 'row') {
    const row = axes.rows.find((r) => r.key === lineKey);
    return row ? axes.columns.map((c) => crossKey(row, c)) : [];
  }
  const column = axes.columns.find((c) => c.key === lineKey);
  return column ? axes.rows.map((r) => crossKey(r, column)) : [];
}

/**
 * Writes one value into many cells - a price, or `null` for "does not exist". The grid's keys are
 * untouched, so it stays as complete as it was.
 */
export function fillCells(matrix: PriceMatrix, keys: string[], value: CellValue): PriceMatrix {
  const cells = { ...matrix.cells };
  for (const key of keys) cells[key] = value;
  return { ...matrix, cells };
}

/** Whether every cell of a row is unavailable - the rows "Masquer les lignes indisponibles" hides. */
export function rowUnavailable(matrix: PriceMatrix, row: GridLine, columns: GridLine[]): boolean {
  return columns.every((c) => matrix.cells[crossKey(row, c)] === null);
}

/**
 * Reads a price typed by a manager, in euros: empty is free (0), a comma is a decimal point, and
 * spaces - the French thousands separator, often a no-break space when pasted - are ignored. Null
 * when the text is not a price at all - the caller keeps the cell as it was.
 *
 * The result is ROUNDED TO THE CENT here, with the rounding `matrixPayload` applies, so the box
 * shows exactly what will be saved ("12,345" reads back as 12.35, never as a price the server
 * would store differently). An amount whose cents are not a safe integer is refused rather than
 * stored as a float the server's whole-cents check would let through rounded.
 */
export function parseEuros(raw: string): number | null {
  const text = raw.replace(/\s/g, '').replace(',', '.');
  if (text === '') return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents / 100 : null;
}

/** The fields of a question the guest-seat rule reads: whether "everyone else" can be reached. */
export interface GuestSeatItem {
  id: string;
  type: string;
  required: boolean;
  options?: { id?: string }[];
  dependsOn?: string;
  showIf?: unknown;
}

/** Single-choice question types, whose one answer sits in at most one group. */
const SINGLE_CHOICE_TYPES = new Set(['single_choice', 'dropdown']);

/**
 * Whether a submitter can land in a criterion's "everyone else" group. Only an `answer` criterion
 * can close it: a required, always-shown choice question whose every option sits in a group.
 */
function othersReachable(dimension: Dimension, items: readonly GuestSeatItem[]): boolean {
  if (dimension.kind !== 'answer') return true;
  const item = items.find((i) => i.id === dimension.questionId);
  if (!item || !item.required) return true;
  // A condition as the server's `normaliseCondition` reads it: an empty `showIf` object is none.
  const conditional =
    !!item.dependsOn ||
    (typeof item.showIf === 'object' &&
      item.showIf !== null &&
      Object.keys(item.showIf).length > 0);
  if (conditional) return true;
  if (!SINGLE_CHOICE_TYPES.has(item.type) && item.type !== 'multiple_choice') return true;
  const grouped = new Set(dimension.buckets.flatMap((b) => b.values ?? []));
  return (item.options ?? []).some((o) => !o.id || !grouped.has(o.id));
}

/**
 * The cell a PUBLIC form's guest would get for free, or null - the one the server refuses on save
 * (`freeFallbackCells`, social-service `forms/answer-options.ts`, decision PP1).
 *
 * Only the TRUE fallback counts: "everyone else" on every criterion, each reachable, priced 0, in a
 * grid that charges somebody. A named option priced 0 ("Sans repas") is a choice the manager made,
 * and a grid that charges nobody is a free form. The editor flags the cell so the refusal is seen
 * where it is fixed, not met as a save error.
 */
export function guestFreeCellKey(
  matrix: PriceMatrix | null,
  items: readonly GuestSeatItem[]
): string | null {
  if (!matrix || matrix.dimensions.length === 0) return null;
  if (!Object.values(matrix.cells).some((v) => typeof v === 'number' && v > 0)) return null;
  if (!matrix.dimensions.every((d) => othersReachable(d, items))) return null;
  const key = cellKey(matrix.dimensions.map(() => OTHERS_BUCKET_ID));
  return matrix.cells[key] === 0 ? key : null;
}

/** Reads a grid off a loaded form, converting cents to euros. Null when the form has no grid. */
export function matrixOf(raw: unknown): PriceMatrix | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as { dimensions?: Dimension[]; cells?: Record<string, CellValue> };
  if (!Array.isArray(doc.dimensions) || doc.dimensions.length === 0) return null;
  const cells: Record<string, CellValue> = {};
  for (const [key, cents] of Object.entries(doc.cells ?? {})) {
    cells[key] = cents === null ? null : (cents ?? 0) / 100;
  }
  return { dimensions: doc.dimensions, cells };
}

/**
 * The payload, in cents - or null, which is how a form or a product says it has no grid.
 *
 * Null must be SENT rather than omitted: on an edit screen an absent field leaves the stored value
 * alone, so a grid the manager just switched off would stay on.
 *
 * `enabled` is the surrounding switch that makes a grid meaningful at all - a form's
 * `requiresPayment`, and nothing on a product, which is always for sale. Off, the grid is dropped
 * rather than kept as dead state nobody can see.
 */
/**
 * Whether a grid that will be SAVED divides on who the person is (promo, formation, cotisation)
 * rather than on their answers only - what a public form's guest has not got, so the public switch
 * stays shut (`FormAdvancedSettings`). A grid the payload drops (`matrixPayload`) counts for nothing.
 */
export function pricesOnProfile(matrix: PriceMatrix | null, enabled = true): boolean {
  return enabled && !!matrix && matrix.dimensions.some((d) => d.kind !== 'answer');
}

export function matrixPayload(matrix: PriceMatrix | null, enabled = true): unknown {
  if (!matrix || !enabled || matrix.dimensions.length === 0) return null;
  const cells: Record<string, CellValue> = {};
  for (const key of allCellKeys(matrix.dimensions)) {
    const value = matrix.cells[key];
    cells[key] = value === null ? null : Math.round((value ?? 0) * 100);
  }
  return { dimensions: matrix.dimensions, cells };
}

/**
 * Why a grid cannot be saved yet - or null when it can.
 *
 * A CODE, not a sentence: the sentence lives in `gridProblem.ts` next to the message table, so the
 * grid editor and the two save buttons all say the same thing about the same state.
 */
export type GridProblem =
  | 'no_criterion'
  | 'empty_criterion'
  | 'unnamed_group'
  | 'no_question'
  | 'empty_group'
  | 'incomplete'
  | 'all_unavailable';

/**
 * The server refuses all of these too; saying it here means the manager is not told about cell keys
 * by a 400.
 */
export function matrixProblem(matrix: PriceMatrix | null): GridProblem | null {
  if (!matrix) return null;
  // The grid is switched ON with nothing to divide on. `matrixPayload` would send null here, so a
  // save would look accepted and quietly keep the single price - the manager must be told instead.
  if (matrix.dimensions.length === 0) return 'no_criterion';
  for (const d of matrix.dimensions) {
    if (d.buckets.length === 0) return 'empty_criterion';
    if (d.buckets.some((b) => !b.label.trim())) return 'unnamed_group';
    if (d.kind === 'answer' && !d.questionId) return 'no_question';
    if (d.kind !== 'cotisation' && d.buckets.some((b) => (b.values ?? []).length === 0))
      return 'empty_group';
    if (
      d.kind === 'cotisation' &&
      d.buckets.some((b) => !b.anyTier && (b.variantKeys ?? []).length === 0)
    )
      return 'empty_group';
  }
  if (!isComplete(matrix)) return 'incomplete';
  // Every combination marked unavailable is a form nobody at all may answer, which is a form that
  // should be closed rather than priced.
  if (allCellKeys(matrix.dimensions).every((k) => matrix.cells[k] === null)) {
    return 'all_unavailable';
  }
  return null;
}

/** The cheapest and dearest price the grid can charge, ignoring unavailable cells. Null when none. */
export function priceRange(matrix: PriceMatrix | null): { min: number; max: number } | null {
  const values = Object.values(matrix?.cells ?? {}).filter(
    (v): v is number => typeof v === 'number'
  );
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
