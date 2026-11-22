import { Log } from '$lib/utils/Log';
import { newProductGridId, seedMissingPrices, type EditorProductGrid } from './productGridEditor';
import {
  PRODUCT_GRID_TYPE,
  productGridCellKey,
  productGridLabelKey,
  type ProductGridAxisEntry,
  type ProductGridColumnSet,
} from './productGridContract';

/**
 * SHARED COLUMN SETS, AS THE EDITOR WORKS THEM (owner, 2026-11-21: "shared size columns for
 * product grids").
 *
 * A set is the SAME columns kept once for several grids of one form - the sizes of a shop. Each
 * grid still stores its own copy of the columns under `columns` (every reader of an answer, a
 * price, a line or an export reads that copy, and so does an older app); `columnSet` only says
 * which grids must stay identical, and the server refuses a form whose grids of one set drifted
 * (`productGridColumnSetRefusal`). So the work is here: every edit of a shared column is written to
 * every grid of its set in the same gesture, and a set exists exactly as long as a grid names it
 * (no form-level field, no migration).
 *
 * Every function mutates the grids it is handed (`$state` proxies) and logs its decision.
 */

const TAG = 'productGridColumnSets';

/** The questions a set is read from: only those holding a priced grid matter. */
export interface ColumnSetQuestion {
  id: string;
  type?: string;
  productGrid?: EditorProductGrid;
}

type GridQuestion = ColumnSetQuestion & { productGrid: EditorProductGrid };

/** A set as the editor offers it: its name, its columns and how many grids use it. */
export interface ColumnSetInfo {
  id: string;
  name: string;
  columns: ProductGridAxisEntry[];
  gridCount: number;
}

function gridsOf(items: readonly ColumnSetQuestion[]): GridQuestion[] {
  return items.filter((i): i is GridQuestion => i.type === PRODUCT_GRID_TYPE && !!i.productGrid);
}

/** The sets the grids of a form name, other than the one `exceptItemId` belongs to. */
export function columnSetsOf(
  items: readonly ColumnSetQuestion[],
  exceptItemId?: string
): ColumnSetInfo[] {
  const sets = new Map<string, ColumnSetInfo>();
  for (const item of gridsOf(items)) {
    const set = item.productGrid.columnSet;
    if (!set) continue;
    const known = sets.get(set.id);
    if (known) {
      known.gridCount += 1;
    } else {
      sets.set(set.id, {
        id: set.id,
        name: set.name,
        columns: item.productGrid.columns.map((c) => ({ id: c.id, label: c.label })),
        gridCount: 1,
      });
    }
  }
  const own = items.find((i) => i.id === exceptItemId)?.productGrid?.columnSet?.id;
  return [...sets.values()].filter((s) => s.id !== own);
}

/** How many grids of a form hold the set `setId`. */
export function gridsInSet(items: readonly ColumnSetQuestion[], setId: string): number {
  return gridsOf(items).filter((i) => i.productGrid.columnSet?.id === setId).length;
}

/**
 * Gives a grid these columns, keeping what the manager typed on them. A column whose label already
 * existed on the grid (compared as the save compares labels) carries its closed cells and its
 * per-column price over to the new id; a column that is gone takes its closed cells and prices with
 * it - the same as removing it; a column new to the grid starts at its category's seed price.
 */
function applyColumns(grid: EditorProductGrid, columns: readonly ProductGridAxisEntry[]): void {
  const next = columns.map((c) => ({ id: c.id, label: c.label }));
  const nextIds = new Set(next.map((c) => c.id));
  const byLabel = new Map(next.map((c) => [productGridLabelKey(c.label), c.id] as const));
  const remap = new Map<string, string>();
  for (const old of grid.columns) {
    const key = productGridLabelKey(old.label);
    const target = byLabel.get(key);
    if (!nextIds.has(old.id) && key && target) remap.set(old.id, target);
  }
  const oldIds = new Set(grid.columns.map((c) => c.id));
  const colOf = (id: string) => remap.get(id) ?? id;

  grid.columns = next;
  const live = new Set(grid.rows.flatMap((r) => next.map((c) => productGridCellKey(r.id, c.id))));
  grid.closedCells = [
    ...new Set(
      grid.closedCells.map((key) => {
        const [rowId, colId] = key.split(':');
        return productGridCellKey(rowId, colOf(colId));
      })
    ),
  ].filter((key) => live.has(key));
  for (const [tierId, list] of Object.entries(grid.pricing.prices)) {
    const kept: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(list)) {
      // A key naming a column of the old copy follows it (or goes); any other key is a row or `*`.
      if (oldIds.has(key) && !nextIds.has(key) && !remap.has(key)) continue;
      kept[colOf(key)] = value;
    }
    grid.pricing.prices[tierId] = kept;
  }
  seedMissingPrices(grid);
}

/** Turns a grid's own columns into a named set: the grid is its first member. */
export function shareColumns(grid: EditorProductGrid, name: string): ProductGridColumnSet {
  const set = { id: newProductGridId(), name: name.trim() };
  grid.columnSet = set;
  Log.d(TAG, `columns shared as a new set of ${grid.columns.length}`);
  return set;
}

/** Puts a grid on an existing set: its columns become the set's, its typed prices follow by label. */
export function useColumnSet(grid: EditorProductGrid, set: ColumnSetInfo): void {
  applyColumns(grid, set.columns);
  grid.columnSet = { id: set.id, name: set.name };
  Log.d(TAG, `a grid joins a set of ${set.columns.length} columns`);
}

/** Takes a grid out of its set: it keeps the columns it has now, as its own from here on. */
export function leaveColumnSet(grid: EditorProductGrid): void {
  grid.columnSet = null;
  Log.d(TAG, 'a grid leaves its column set and keeps its columns');
}

/** Renames the set of a grid (written to its siblings by {@link propagateColumnSet}). */
export function renameColumnSet(grid: EditorProductGrid, name: string): void {
  if (grid.columnSet) grid.columnSet = { id: grid.columnSet.id, name };
}

/**
 * Writes the columns and the name of `source`'s set to every OTHER grid of the form naming it: the
 * one step that keeps a shared edit shared. Returns how many grids it changed.
 */
export function propagateColumnSet(
  items: readonly ColumnSetQuestion[],
  source: EditorProductGrid
): number {
  const set = source.columnSet;
  if (!set) return 0;
  let changed = 0;
  for (const item of gridsOf(items)) {
    const grid = item.productGrid;
    if (grid === source || grid.columnSet?.id !== set.id) continue;
    applyColumns(grid, source.columns);
    grid.columnSet = { id: set.id, name: set.name };
    changed += 1;
  }
  Log.d(TAG, `a shared edit written to ${changed} other grid(s)`);
  return changed;
}

/**
 * The grids that already hold exactly the columns of `grid` (same labels, same order) and name no
 * set: what "share these columns" may attach in the same click, so a form whose sizes were typed
 * eighteen times is one click, not eighteen. A grid listed in `ordered` (it has answers) is left
 * out: re-keying its columns is a decision the manager takes on that grid, with its warning.
 */
export function gridsWithSameColumns(
  items: readonly ColumnSetQuestion[],
  grid: EditorProductGrid,
  ordered: ReadonlySet<string> = new Set()
): ColumnSetQuestion[] {
  const signature = (g: EditorProductGrid) =>
    JSON.stringify(g.columns.map((c) => productGridLabelKey(c.label)));
  const mine = signature(grid);
  // Blank labels name nothing: two grids of unnamed columns do not hold "the same" ones.
  if (grid.columns.some((c) => !productGridLabelKey(c.label))) return [];
  return gridsOf(items).filter(
    (i) =>
      i.productGrid !== grid &&
      !i.productGrid.columnSet &&
      !ordered.has(i.id) &&
      signature(i.productGrid) === mine
  );
}

/** Attaches the grids of `members` to the set `grid` just created. */
export function joinColumnSet(
  members: readonly ColumnSetQuestion[],
  grid: EditorProductGrid
): void {
  const set = grid.columnSet;
  if (!set) return;
  for (const member of members) {
    if (!member.productGrid) continue;
    applyColumns(member.productGrid, grid.columns);
    member.productGrid.columnSet = { id: set.id, name: set.name };
  }
  Log.d(TAG, `${members.length} grid(s) with the same columns joined the set`);
}

/**
 * The cells ordered on a grid AND on the other grids of its set: a column shared by several grids is
 * removed from all of them, so the warning the editor already shows before removing an ordered
 * column (`axisEntryHasOrders`) must read every grid's orders. Row ids are per grid, so another
 * grid's cells never make a row of this one look ordered.
 */
export function orderedCellsOfSet(
  items: readonly ColumnSetQuestion[],
  itemId: string,
  ordered: Record<string, string[]>
): string[] {
  const own = items.find((i) => i.id === itemId);
  const setId = own?.productGrid?.columnSet?.id;
  const cells = new Set(ordered[itemId] ?? []);
  if (setId) {
    for (const item of gridsOf(items)) {
      if (item.productGrid.columnSet?.id === setId) {
        for (const key of ordered[item.id] ?? []) cells.add(key);
      }
    }
  }
  return [...cells];
}
