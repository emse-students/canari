/**
 * THE PRICED GRID'S EDITOR MODEL (WP-G3): every edit the table makes, the payload it becomes, and
 * that payload judged by the contract the server judges it by.
 */
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  PRODUCT_GRID_DEFINITION_CODES,
  PRODUCT_GRID_ID_PATTERN,
  productGridItemRefusal,
} from './productGridContract';
import {
  addAxisEntries,
  addBlankEntry,
  axisEntryHasOrders,
  collidingLabelKeys,
  editorProductGrid,
  editorTierIds,
  euroInputText,
  firstProductGridProblem,
  isCellClosed,
  moveAxisEntry,
  newProductGrid,
  orderedProductGridCells,
  parseEuroInput,
  priceOf,
  productGridDefinitionMessage,
  productGridPayload,
  profileTierCriterion,
  removeAxisEntry,
  setMaxPerCell,
  setPrice,
  setPriceMode,
  setTiers,
  splitPastedList,
  syncTierLists,
  toggleClosedCell,
  withFreshProductGridIds,
  type EditorProductGrid,
  type ProductGridTierDimension,
} from './productGridEditor';
import { formCodeMessage } from './answerBounds';

/** A sweat grid: three colours x three sizes, 28 EUR for everyone. */
function sweat(): EditorProductGrid {
  const grid = newProductGrid();
  grid.rows = [];
  grid.columns = [];
  addAxisEntries(grid, 'rows', ['Vert', 'Noir', 'Creme']);
  addAxisEntries(grid, 'columns', ['S', 'M', 'L']);
  setPrice(grid, '_all', '*', 28);
  return grid;
}

const PAID = { isPublic: false, requiresPayment: true };
const judge = (grid: EditorProductGrid, form = PAID) =>
  productGridItemRefusal({ required: true, productGrid: productGridPayload(grid) }, form);

const cotisants: ProductGridTierDimension = {
  id: 'd1',
  kind: 'cotisation',
  buckets: [{ id: 'b1', label: 'Cotisant', anyTier: true }],
};

describe('a new grid', () => {
  it('starts with one blank row and column, one blank price, 5 per cell, ids the contract accepts', () => {
    const grid = newProductGrid();
    expect(grid.rows).toHaveLength(1);
    expect(grid.columns).toHaveLength(1);
    expect(grid.maxPerCell).toBe(5);
    expect(PRODUCT_GRID_ID_PATTERN.test(grid.rows[0].id)).toBe(true);
    expect(PRODUCT_GRID_ID_PATTERN.test(grid.columns[0].id)).toBe(true);
    // Blank labels and a blank price: the save names it, never charges 0.
    expect(judge(grid)?.code).toBe('PRODUCT_GRID_LABEL_INVALID');
  });

  it('becomes a grid the contract accepts once named and priced', () => {
    expect(judge(sweat())).toBeNull();
  });
});

describe('rows and columns', () => {
  it('pastes a list split on lines, commas and semicolons, in order', () => {
    expect(splitPastedList('Rouge\nKaki, Blanc;  \n\tGris ')).toEqual([
      'Rouge',
      'Kaki',
      'Blanc',
      'Gris',
    ]);
  });

  it('refuses a label already on the axis, case and spaces folded, and names it', () => {
    const grid = sweat();
    const result = addAxisEntries(grid, 'rows', ['vert ', 'Bordeaux', 'BORDEAUX']);
    expect(result).toEqual({ added: 1, duplicates: ['vert', 'BORDEAUX'], overflow: 0 });
    expect(grid.rows.map((r) => r.label)).toEqual(['Vert', 'Noir', 'Creme', 'Bordeaux']);
  });

  it('counts what goes past the axis maximum instead of dropping it silently', () => {
    const grid = sweat();
    const sizes = Array.from({ length: 14 }, (_, i) => `T${i}`);
    expect(addAxisEntries(grid, 'columns', sizes).overflow).toBe(2);
    expect(grid.columns).toHaveLength(15);
    expect(addBlankEntry(grid, 'columns')).toBe(false);
  });

  it('renaming a label keeps its id, so answers and prices keep pointing at it', () => {
    const grid = sweat();
    const id = grid.rows[0].id;
    grid.rows[0].label = 'Vert sapin';
    expect(grid.rows[0].id).toBe(id);
  });

  it('removes an entry with its closed cells and its prices, and keeps the last one', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_row');
    const [vert, noir] = grid.rows;
    toggleClosedCell(grid, vert.id, grid.columns[0].id);
    toggleClosedCell(grid, noir.id, grid.columns[0].id);
    expect(removeAxisEntry(grid, 'rows', vert.id)).toBe(true);
    expect(grid.closedCells).toEqual([`${noir.id}:${grid.columns[0].id}`]);
    expect(grid.pricing.prices._all[vert.id]).toBeUndefined();
    removeAxisEntry(grid, 'rows', noir.id);
    expect(removeAxisEntry(grid, 'rows', grid.rows[0].id)).toBe(false);
    expect(grid.rows).toHaveLength(1);
  });

  it('moves an entry, and refuses a move off the axis', () => {
    const grid = sweat();
    expect(moveAxisEntry(grid, 'columns', 2, 0)).toBe(true);
    expect(grid.columns.map((c) => c.label)).toEqual(['L', 'S', 'M']);
    expect(moveAxisEntry(grid, 'columns', 0, -1)).toBe(false);
  });
});

describe('closed cells', () => {
  it('closes and reopens a combination', () => {
    const grid = sweat();
    const [row, col] = [grid.rows[2].id, grid.columns[0].id];
    toggleClosedCell(grid, row, col);
    expect(isCellClosed(grid, row, col)).toBe(true);
    expect(productGridPayload(grid).closedCells).toEqual([`${row}:${col}`]);
    toggleClosedCell(grid, row, col);
    expect(isCellClosed(grid, row, col)).toBe(false);
  });

  it('keeps the last open cell open: a grid nobody can order from is refused', () => {
    const grid = newProductGrid();
    expect(toggleClosedCell(grid, grid.rows[0].id, grid.columns[0].id)).toBe(false);
    expect(grid.closedCells).toEqual([]);
  });
});

describe('the cap per cell', () => {
  it('is clamped to 1..99', () => {
    const grid = sweat();
    setMaxPerCell(grid, 0);
    expect(grid.maxPerCell).toBe(1);
    setMaxPerCell(grid, 250);
    expect(grid.maxPerCell).toBe(99);
  });
});

describe('price modes', () => {
  it('per row: each row starts at the single price, and the payload names every row once', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_row');
    setPrice(grid, '_all', grid.rows[1].id, 30);
    const payload = productGridPayload(grid);
    expect(payload.pricing.mode).toBe('per_row');
    expect(payload.pricing.prices).toEqual({
      _all: { [grid.rows[0].id]: 2800, [grid.rows[1].id]: 3000, [grid.rows[2].id]: 2800 },
    });
    expect(judge(grid)).toBeNull();
  });

  it('per column: a column added later starts at the last column price', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_column');
    setPrice(grid, '_all', '*', null);
    setPrice(grid, '_all', grid.columns[2].id, 31);
    addAxisEntries(grid, 'columns', ['XL']);
    expect(priceOf(grid, '_all', grid.columns[3].id)).toBe(31);
    expect(judge(grid)).toBeNull();
  });

  it('switching back to one price reads a price the list already holds', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_row');
    delete grid.pricing.prices._all['*'];
    setPriceMode(grid, 'single');
    expect(priceOf(grid, '_all', '*')).toBe(28);
  });

  it('a blank price is left out, so the contract names the list incomplete', () => {
    const grid = sweat();
    setPrice(grid, '_all', '*', null);
    expect(productGridPayload(grid).pricing.prices).toEqual({ _all: {} });
    expect(judge(grid)?.code).toBe('PRODUCT_GRID_PRICES_INCOMPLETE');
  });
});

describe('categories', () => {
  it('one tab per bucket then "Autres", each a copy of the list on screen', () => {
    const grid = sweat();
    setTiers(grid, JSON.parse(JSON.stringify(cotisants)));
    expect(editorTierIds(grid)).toEqual(['b1', '_others']);
    expect(priceOf(grid, 'b1', '*')).toBe(28);
    expect(priceOf(grid, '_others', '*')).toBe(28);
    setPrice(grid, '_others', '*', 31);
    const payload = productGridPayload(grid);
    expect(payload.pricing.prices).toEqual({ b1: { '*': 2800 }, _others: { '*': 3100 } });
    expect(payload.pricing.tiers?.kind).toBe('cotisation');
    expect(judge(grid)).toBeNull();
  });

  it('a category added later starts from "Autres"', () => {
    const grid = sweat();
    setTiers(grid, JSON.parse(JSON.stringify(cotisants)));
    setPrice(grid, '_others', '*', 31);
    grid.pricing.tiers!.buckets.push({ id: 'b2', label: 'BDS', anyTier: true });
    syncTierLists(grid);
    expect(priceOf(grid, 'b2', '*')).toBe(31);
  });

  it('turning categories off keeps one list for everybody, from "Autres"', () => {
    const grid = sweat();
    setTiers(grid, JSON.parse(JSON.stringify(cotisants)));
    setTiers(grid, null);
    expect(editorTierIds(grid)).toEqual(['_all']);
    expect(Object.keys(productGridPayload(grid).pricing.prices)).toEqual(['_all']);
  });

  it('a public form must price "Autres": what a guest pays is named first', () => {
    const grid = sweat();
    setTiers(grid, JSON.parse(JSON.stringify(cotisants)));
    setPrice(grid, '_others', '*', null);
    expect(judge(grid, { isPublic: true, requiresPayment: true })?.code).toBe(
      'PRODUCT_GRID_GUEST_PRICE_MISSING'
    );
  });

  it('copies the registration price grid profile criterion, never an answer criterion', () => {
    const answer = { id: 'd0', kind: 'answer' as const, buckets: [{ id: 'x', label: 'x' }] };
    expect(profileTierCriterion({ dimensions: [answer, cotisants] }, true)).toBe(cotisants);
    expect(profileTierCriterion({ dimensions: [answer] }, true)).toBeNull();
    expect(profileTierCriterion({ dimensions: [cotisants] }, false)).toBeNull();
  });
});

describe('the wire trip', () => {
  it('reads cents back as euros and writes them back unchanged', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_column');
    setPrice(grid, '_all', grid.columns[0].id, 12.35);
    const stored = productGridPayload(grid);
    const back = editorProductGrid(stored);
    expect(priceOf(back, '_all', grid.columns[0].id)).toBe(12.35);
    expect(productGridPayload(back)).toEqual(stored);
  });

  it('a broken stored grid opens as a new one rather than an empty card', () => {
    expect(editorProductGrid(null).rows).toHaveLength(1);
    expect(editorProductGrid({ rows: 'x' }).columns).toHaveLength(1);
  });

  it('parses a typed price with a comma or a dot, and refuses what is not one', () => {
    expect(parseEuroInput('12,50')).toBe(12.5);
    expect(parseEuroInput(' 3.2 ')).toBe(3.2);
    expect(parseEuroInput('')).toBeNull();
    expect(parseEuroInput('-2')).toBeNull();
    expect(parseEuroInput('abc')).toBeNull();
    expect(euroInputText(null)).toBe('');
  });

  it('refuses what Number() reads but nobody types as a price, and rounds to the cent', () => {
    for (const text of ['1e3', '0x10', 'Infinity', '+5', '1,000,50', '1.000,50', '.', '5-']) {
      expect(parseEuroInput(text)).toBeNull();
    }
    expect(parseEuroInput('1 000,50 €')).toBe(1000.5);
    expect(parseEuroInput(',5')).toBe(0.5);
    expect(parseEuroInput('19,999')).toBe(20);
    expect(parseEuroInput('1,005')).toBe(1.01);
  });

  it('turns a typed 19,99 into 1999 cents, and every stored cent amount survives the trip back', () => {
    const grid = newProductGrid();
    grid.rows[0].label = 'Vert';
    grid.columns[0].label = 'M';
    setPrice(grid, '_all', '*', parseEuroInput('19,99'));
    expect(productGridPayload(grid).pricing.prices._all['*']).toBe(1999);
    // Every amount the contract accepts, read back as euros and sent again, is the same cents.
    // Checked in a plain loop (an `expect` per amount would take seconds), the misses collected.
    const misses: number[] = [];
    for (let cents = 0; cents <= 1_000_000; cents += 1) {
      const euros = cents / 100;
      if (Math.round(euros * 100) !== cents || parseEuroInput(euroInputText(euros)) !== euros) {
        misses.push(cents);
      }
    }
    expect(misses).toEqual([]);
  });

  it('keeps a price above the contract bound, so the save names it rather than clamping it', () => {
    const grid = newProductGrid();
    grid.rows[0].label = 'Vert';
    grid.columns[0].label = 'M';
    setPrice(grid, '_all', '*', parseEuroInput('10000,01'));
    expect(productGridPayload(grid).pricing.prices._all['*']).toBe(1_000_001);
    expect(judge(grid)?.code).toBe('PRODUCT_GRID_PRICE_INVALID');
  });
});

describe('a duplicated grid', () => {
  it('gets fresh row and column ids, its closed cells and price keys following them', () => {
    const grid = sweat();
    setPriceMode(grid, 'per_row');
    setPrice(grid, '_all', grid.rows[0].id, 25);
    toggleClosedCell(grid, grid.rows[2].id, grid.columns[0].id);
    const copy = withFreshProductGridIds(grid);
    const oldIds = [...grid.rows, ...grid.columns].map((e) => e.id);
    for (const entry of [...copy.rows, ...copy.columns]) expect(oldIds).not.toContain(entry.id);
    expect(copy.rows.map((r) => r.label)).toEqual(['Vert', 'Noir', 'Creme']);
    expect(copy.closedCells).toEqual([`${copy.rows[2].id}:${copy.columns[0].id}`]);
    expect(priceOf(copy, '_all', copy.rows[0].id)).toBe(25);
    expect(judge(copy)).toBeNull();
    // The original is untouched.
    expect(grid.closedCells).toEqual([`${grid.rows[2].id}:${grid.columns[0].id}`]);
  });
});

describe('the words of a refusal', () => {
  it('has a sentence for every definition code, the editor and the server alike', () => {
    for (const code of PRODUCT_GRID_DEFINITION_CODES) {
      expect(productGridDefinitionMessage(code)).toBeTruthy();
      expect(formCodeMessage(code)).toBe(productGridDefinitionMessage(code));
    }
    expect(productGridDefinitionMessage('SOMETHING_ELSE')).toBeNull();
  });

  it('names the first faulty grid and its question', () => {
    const blank = newProductGrid();
    const items = [
      { id: 'q1', type: 'short_text', label: 'Nom' },
      { id: 'q2', type: 'product_grid', label: 'Sweat', required: true, productGrid: sweat() },
      { id: 'q3', type: 'product_grid', label: 'Veste', required: true, productGrid: blank },
    ];
    expect(firstProductGridProblem(items, PAID)).toEqual({
      itemId: 'q3',
      message: m.form_pgrid_problem_in_question({
        label: 'Veste',
        problem: m.form_pgrid_refusal_label({ max: 100 }),
      }),
    });
    expect(firstProductGridProblem(items.slice(0, 2), PAID)).toBeNull();
    expect(
      firstProductGridProblem(items.slice(1, 2), { isPublic: false, requiresPayment: false })
        ?.message
    ).toContain(m.form_pgrid_refusal_requires_payment());
  });
});

describe('ordered cells', () => {
  it('reads the cells some answer ordered, per grid, and which rows or columns they name', () => {
    const ordered = orderedProductGridCells(
      [
        { answers: { g: { 'r1:c1': 2, 'r2:c1': 0 }, q: 'x' } },
        { answers: { g: { 'r1:c2': 1 } } },
        { answers: null },
      ],
      ['g']
    );
    expect(ordered.g.sort()).toEqual(['r1:c1', 'r1:c2']);
    expect(axisEntryHasOrders(ordered.g, 'rows', 'r1')).toBe(true);
    expect(axisEntryHasOrders(ordered.g, 'rows', 'r2')).toBe(false);
    expect(axisEntryHasOrders(ordered.g, 'columns', 'c2')).toBe(true);
  });
});

describe('colliding labels', () => {
  it('folds case and spaces as the save does, and ignores blanks', () => {
    const keys = collidingLabelKeys([
      { id: 'a', label: 'Vert' },
      { id: 'b', label: ' vert ' },
      { id: 'c', label: '' },
      { id: 'd', label: '' },
      { id: 'e', label: 'Noir' },
    ]);
    expect([...keys]).toEqual(['vert']);
  });
});
