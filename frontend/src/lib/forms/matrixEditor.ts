import { Log } from '$lib/utils/Log';
import { GRID_MAX_ROWS } from './answerBounds';
import { movedList } from './listMove';
import type { AddEntriesResult, ProductGridAxis } from './productGridEditor';
import { isMatrixType, matrixTypeFor, MATRIX_MULTIPLE_TYPE } from './questionTypes';

/**
 * THE "GRILLE DE CHOIX" IN THE EDITOR (`matrix_single` / `matrix_multiple`), as the shared axis
 * table (`GridAxesTable.svelte`) edits it - the same table, reorder, add and remove as the priced
 * grid's (owner, 2026-11-07: both grids look and behave alike).
 *
 * The stored shape is untouched: rows are `{ id, value }` (flattened to strings on the wire by
 * `toFormItemsPayload`), columns are the question's `options` `{ id, label }`. These functions read
 * that shape as `{ id, label }` entries and write back through it, mutating the question they are
 * handed (a `$state` proxy in the component).
 */

const TAG = 'matrixEditor';

/** One row or column as the table draws it. */
export interface MatrixAxisEntry {
  id: string;
  label: string;
}

/** The part of a question this module reads and writes. */
export interface EditorMatrixQuestion {
  type: string;
  rows?: ({ id: string; value: string } | string)[];
  options?: { id?: string; label: string; priceModifier?: number }[];
}

/** The most entries an axis may hold: the rows the save accepts (50); columns are not bounded. */
export function matrixAxisMax(axis: ProductGridAxis): number {
  return axis === 'rows' ? GRID_MAX_ROWS : Number.POSITIVE_INFINITY;
}

/** Rows as `{ id, value }` (a legacy string row gets an id), columns with an id each. */
function normalise(item: EditorMatrixQuestion): void {
  // Written only when something is missing: a write to the question re-renders its card.
  if (!item.rows || item.rows.some((row) => typeof row === 'string')) {
    item.rows = (item.rows ?? []).map((row) =>
      typeof row === 'string' ? { id: crypto.randomUUID(), value: row } : row
    );
  }
  if (!item.options || item.options.some((o) => !o.id)) {
    item.options = (item.options ?? []).map((o) => (o.id ? o : { ...o, id: crypto.randomUUID() }));
  }
}

/** The entries of one axis, in order. */
export function matrixAxisEntries(
  item: EditorMatrixQuestion,
  axis: ProductGridAxis
): MatrixAxisEntry[] {
  if (axis === 'rows') {
    return (item.rows ?? []).map((row) =>
      typeof row === 'string' ? { id: row, label: row } : { id: row.id, label: row.value }
    );
  }
  return (item.options ?? []).map((o) => ({ id: o.id ?? '', label: o.label ?? '' }));
}

/** Renames one entry; its id never changes. */
export function renameMatrixEntry(
  item: EditorMatrixQuestion,
  axis: ProductGridAxis,
  id: string,
  label: string
): void {
  normalise(item);
  if (axis === 'rows') {
    const row = (item.rows as { id: string; value: string }[]).find((r) => r.id === id);
    if (row) row.value = label;
  } else {
    const column = item.options!.find((o) => o.id === id);
    if (column) column.label = label;
  }
}

function append(item: EditorMatrixQuestion, axis: ProductGridAxis, label: string): void {
  const id = crypto.randomUUID();
  if (axis === 'rows') item.rows = [...(item.rows ?? []), { id, value: label }];
  else item.options = [...(item.options ?? []), { id, label, priceModifier: undefined }];
}

/** Appends one blank entry, the "+" of an axis. False when the axis is full. */
export function addBlankMatrixEntry(item: EditorMatrixQuestion, axis: ProductGridAxis): boolean {
  normalise(item);
  if (matrixAxisEntries(item, axis).length >= matrixAxisMax(axis)) {
    Log.d(TAG, `no blank ${axis} entry: the axis is full`);
    return false;
  }
  append(item, axis, '');
  return true;
}

/**
 * Appends pasted labels in order. A label already on the axis - compared as typed and trimmed, as
 * the save's duplicate check compares them (`duplicateLabels`) - is refused and named; past the
 * axis's maximum the rest is counted, never silently dropped.
 */
export function addMatrixEntries(
  item: EditorMatrixQuestion,
  axis: ProductGridAxis,
  labels: readonly string[]
): AddEntriesResult {
  normalise(item);
  // The one blank entry a new grid starts with gives way to a pasted list.
  const current = matrixAxisEntries(item, axis);
  if (current.length === 1 && !current[0].label.trim()) {
    if (axis === 'rows') item.rows = [];
    else item.options = [];
  }
  const taken = new Set(
    matrixAxisEntries(item, axis)
      .map((e) => e.label.trim())
      .filter(Boolean)
  );
  const result: AddEntriesResult = { added: 0, duplicates: [], overflow: 0 };
  for (const raw of labels) {
    const label = raw.trim();
    if (label && taken.has(label)) {
      result.duplicates.push(label);
      continue;
    }
    if (matrixAxisEntries(item, axis).length >= matrixAxisMax(axis)) {
      result.overflow += 1;
      continue;
    }
    append(item, axis, label);
    if (label) taken.add(label);
    result.added += 1;
  }
  Log.d(
    TAG,
    `added ${result.added} ${axis} (${result.duplicates.length} duplicate, ${result.overflow} over the limit)`
  );
  return result;
}

/** Removes an entry. Refused when it is the last of its axis: a grid keeps one row and one column. */
export function removeMatrixEntry(
  item: EditorMatrixQuestion,
  axis: ProductGridAxis,
  id: string
): boolean {
  normalise(item);
  if (matrixAxisEntries(item, axis).length <= 1) {
    Log.d(TAG, `the last ${axis} entry is kept`);
    return false;
  }
  if (axis === 'rows') {
    item.rows = (item.rows as { id: string; value: string }[]).filter((r) => r.id !== id);
  } else {
    item.options = item.options!.filter((o) => o.id !== id);
  }
  Log.d(TAG, `removed one ${axis} entry`);
  return true;
}

/** Moves an entry from one position to another on its axis; out-of-range moves do nothing. */
export function moveMatrixEntry(
  item: EditorMatrixQuestion,
  axis: ProductGridAxis,
  from: number,
  to: number
): boolean {
  normalise(item);
  const list: unknown[] = axis === 'rows' ? item.rows! : item.options!;
  const next = movedList(list, from, to);
  if (!next) return false;
  if (axis === 'rows') item.rows = next as { id: string; value: string }[];
  else item.options = next as EditorMatrixQuestion['options'];
  Log.d(TAG, `moved a ${axis} entry from ${from} to ${to}`);
  return true;
}

/**
 * Makes sure each axis holds at least one entry, so the table has a row and a column to type in -
 * a question just turned into a grid, or a new one. A blank entry is dropped by the save.
 */
export function ensureMatrixAxes(item: EditorMatrixQuestion): void {
  normalise(item);
  if (item.rows!.length === 0) append(item, 'rows', '');
  if (item.options!.length === 0) append(item, 'columns', '');
}

/** Whether the "Plusieurs reponses par ligne" switch is on: the stored type says so. */
export function matrixAllowsMultiple(item: EditorMatrixQuestion): boolean {
  return item.type === MATRIX_MULTIPLE_TYPE;
}

/** The switch: writes the stored type it maps to. Does nothing to a question that is no grid. */
export function setMatrixMultiple(item: EditorMatrixQuestion, multiplePerRow: boolean): void {
  if (!isMatrixType(item.type)) return;
  item.type = matrixTypeFor(multiplePerRow);
  Log.d(TAG, `the grid is now ${item.type}`);
}
