import { describe, it, expect } from 'vitest';
import {
  columnSetsOf,
  gridsInSet,
  gridsWithSameColumns,
  joinColumnSet,
  leaveColumnSet,
  orderedCellsOfSet,
  propagateColumnSet,
  renameColumnSet,
  shareColumns,
  useColumnSet,
  type ColumnSetQuestion,
} from './productGridColumnSets';
import {
  addAxisEntries,
  editorProductGrid,
  firstProductGridProblem,
  newProductGrid,
  productGridPayload,
  removeAxisEntry,
  setPrice,
  setPriceMode,
  toggleClosedCell,
  withFreshProductGridIds,
  type EditorProductGrid,
} from './productGridEditor';

/** A shop grid: the given product colours as rows, the sizes as columns, one price. */
function shopGrid(
  rows: string[],
  sizes: string[] = ['S', 'M', 'L'],
  euros = 28
): EditorProductGrid {
  const grid = newProductGrid();
  grid.rows = [];
  grid.columns = [];
  addAxisEntries(grid, 'rows', rows);
  addAxisEntries(grid, 'columns', sizes);
  setPrice(grid, '_all', '*', euros);
  return grid;
}
const question = (id: string, productGrid: EditorProductGrid): ColumnSetQuestion => ({
  id,
  type: 'product_grid',
  productGrid,
});
const labels = (g: EditorProductGrid) => g.columns.map((c) => c.label);
const paid = { isPublic: false, requiresPayment: true };

describe('shared column sets - sharing and joining', () => {
  it('sharing names a set on the grid and leaves its columns exactly as they are', () => {
    const grid = shopGrid(['Vert']);
    const before = JSON.stringify(grid.columns);
    const set = shareColumns(grid, '  Tailles ');
    expect(set.name).toBe('Tailles');
    expect(grid.columnSet).toEqual(set);
    expect(JSON.stringify(grid.columns)).toBe(before);
  });

  it('a grid that typed the same labels joins by label: closed cells and per-column prices follow', () => {
    const a = shopGrid(['Vert']);
    shareColumns(a, 'Tailles');
    const b = shopGrid(['Noir', 'Bleu'], ['S', 'M', 'L']);
    setPriceMode(b, 'per_column');
    setPrice(b, '_all', b.columns[1].id, 31);
    toggleClosedCell(b, b.rows[0].id, b.columns[1].id);
    const mId = a.columns[1].id;
    useColumnSet(b, columnSetsOf([question('a', a)])[0]);
    expect(b.columns).toEqual(a.columns);
    expect(b.columnSet).toEqual(a.columnSet);
    expect(b.closedCells).toEqual([`${b.rows[0].id}:${mId}`]);
    expect(b.pricing.prices._all[mId]).toBe(31);
    expect(firstProductGridProblem([question('a', a), question('b', b)], paid)).toBeNull();
  });

  it('a column the set lacks takes its closed cells and prices with it; a new one is seeded', () => {
    const a = shopGrid(['Vert'], ['S', 'M']);
    shareColumns(a, 'Tailles');
    const b = shopGrid(['Noir'], ['S', 'M', 'XXL']);
    setPriceMode(b, 'per_column');
    const xxl = b.columns[2].id;
    setPrice(b, '_all', xxl, 40);
    toggleClosedCell(b, b.rows[0].id, xxl);
    useColumnSet(b, columnSetsOf([question('a', a)])[0]);
    expect(labels(b)).toEqual(['S', 'M']);
    expect(b.closedCells).toEqual([]);
    const sent = Object.keys(productGridPayload(b).pricing.prices._all).sort();
    expect(sent).toEqual(b.columns.map((c) => c.id).sort());
  });

  it('offers the sets of the OTHER grids, with their column count and members', () => {
    const a = shopGrid(['A']);
    shareColumns(a, 'Tailles');
    const b = shopGrid(['B']);
    const c = shopGrid(['C']);
    joinColumnSet([question('b', b)], a);
    const items = [question('a', a), question('b', b), question('c', c)];
    const offered = columnSetsOf(items, 'c');
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ name: 'Tailles', gridCount: 2 });
    expect(offered[0].columns).toHaveLength(3);
    expect(columnSetsOf(items, 'a')).toHaveLength(0);
    expect(gridsInSet(items, a.columnSet!.id)).toBe(2);
  });

  it('finds the grids already typed with the same sizes, never one with answers or in a set', () => {
    const a = shopGrid(['A']);
    const same = shopGrid(['B']);
    const different = shopGrid(['C'], ['S', 'M']);
    const reordered = shopGrid(['D'], ['M', 'S', 'L']);
    const inOther = shopGrid(['E']);
    shareColumns(inOther, 'Ailleurs');
    const ordered = shopGrid(['F']);
    const items = [a, same, different, reordered, inOther, ordered].map((g, i) =>
      question(`q${i}`, g)
    );
    const found = gridsWithSameColumns(items, a, new Set(['q5'])).map((i) => i.id);
    expect(found).toEqual(['q1']);
  });

  it('blank column labels are never taken for "the same columns"', () => {
    const a = newProductGrid();
    const b = newProductGrid();
    expect(gridsWithSameColumns([question('a', a), question('b', b)], a)).toEqual([]);
  });
});

describe('shared column sets - an edit is written to every grid of the set', () => {
  function threeGrids() {
    const a = shopGrid(['Vert']);
    shareColumns(a, 'Tailles');
    const b = shopGrid(['Noir']);
    const c = shopGrid(['Bleu']);
    joinColumnSet([question('b', b), question('c', c)], a);
    return { a, b, c, items: [question('a', a), question('b', b), question('c', c)] };
  }

  it('renaming, adding, moving and removing a column reach the others, ids unchanged', () => {
    const { a, b, c, items } = threeGrids();
    a.columns[0].label = 'Small';
    addAxisEntries(a, 'columns', ['XL']);
    expect(propagateColumnSet(items, a)).toBe(2);
    for (const g of [b, c]) {
      expect(g.columns).toEqual(a.columns);
      expect(labels(g)).toEqual(['Small', 'M', 'L', 'XL']);
    }
    expect(firstProductGridProblem(items, paid)).toBeNull();

    const [first, second] = [a.columns[0].id, a.columns[1].id];
    removeAxisEntry(a, 'columns', second);
    propagateColumnSet(items, a);
    expect(b.columns.map((x) => x.id)).not.toContain(second);
    expect(b.columns[0].id).toBe(first);
    expect(firstProductGridProblem(items, paid)).toBeNull();
  });

  it('removing a column drops its closed cells and per-column price on every grid', () => {
    const { a, b, items } = threeGrids();
    setPriceMode(b, 'per_column');
    const target = a.columns[2].id;
    toggleClosedCell(b, b.rows[0].id, target);
    removeAxisEntry(a, 'columns', target);
    propagateColumnSet(items, a);
    expect(b.closedCells).toEqual([]);
    expect(Object.keys(b.pricing.prices._all)).not.toContain(target);
    expect(firstProductGridProblem(items, paid)).toBeNull();
  });

  it('renaming the set reaches the others; a grid that left keeps its columns, untouched after', () => {
    const { a, b, c, items } = threeGrids();
    renameColumnSet(a, 'Pointures');
    propagateColumnSet(items, a);
    expect(b.columnSet?.name).toBe('Pointures');
    leaveColumnSet(c);
    expect(c.columnSet).toBeNull();
    a.columns[0].label = 'Petit';
    propagateColumnSet(items, a);
    expect(c.columns[0].label).toBe('S');
    expect(b.columns[0].label).toBe('Petit');
    expect(firstProductGridProblem(items, paid)).toBeNull();
  });

  it('a forgotten propagation is refused before the save, naming the grid that drifted', () => {
    const { a, items } = threeGrids();
    a.columns[0].label = 'Petit';
    const problem = firstProductGridProblem(items, paid);
    expect(problem?.itemId).toBe('b');
  });

  it('a shared column warns about the orders of ANY grid of its set, not about other rows', () => {
    const { a, b, items } = threeGrids();
    const ordered = { b: [`${b.rows[0].id}:${a.columns[1].id}`], other: ['x:y'] };
    expect(orderedCellsOfSet(items, 'a', ordered)).toEqual([`${b.rows[0].id}:${a.columns[1].id}`]);
    // A grid outside every set reads only its own.
    const solo = [...items, question('solo', shopGrid(['Z']))];
    expect(orderedCellsOfSet(solo, 'solo', ordered)).toEqual([]);
  });
});

describe('shared column sets - the payload, a duplicate and an old grid', () => {
  it('a grid with no set sends no columnSet key, byte for byte what it always sent', () => {
    const grid = shopGrid(['Vert']);
    expect(productGridPayload(grid)).not.toHaveProperty('columnSet');
    expect(editorProductGrid(productGridPayload(grid))).not.toHaveProperty('columnSet');
  });

  it('a grid in a set sends it, and it round-trips through the editor', () => {
    const grid = shopGrid(['Vert']);
    shareColumns(grid, 'Tailles');
    const wire = productGridPayload(grid);
    expect(wire.columnSet).toEqual(grid.columnSet);
    expect(editorProductGrid(wire).columnSet).toEqual(grid.columnSet);
  });

  it('a duplicated grid keeps its shared columns and gets fresh rows, closed cells following', () => {
    const grid = shopGrid(['Vert', 'Noir']);
    shareColumns(grid, 'Tailles');
    toggleClosedCell(grid, grid.rows[0].id, grid.columns[1].id);
    const copy = withFreshProductGridIds(grid);
    expect(copy.columns).toEqual(grid.columns);
    expect(copy.columnSet).toEqual(grid.columnSet);
    expect(copy.rows[0].id).not.toBe(grid.rows[0].id);
    expect(copy.closedCells).toEqual([`${copy.rows[0].id}:${grid.columns[1].id}`]);
    const items = [question('a', grid), question('b', copy)];
    expect(firstProductGridProblem(items, paid)).toBeNull();
  });

  it('a duplicated grid with no set gets fresh columns, as before', () => {
    const grid = shopGrid(['Vert']);
    const copy = withFreshProductGridIds(grid);
    expect(copy.columns[0].id).not.toBe(grid.columns[0].id);
  });
});
