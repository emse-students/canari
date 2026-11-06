import { OTHERS_BUCKET_ID } from '../pricing/audience';
import {
  PRODUCT_GRID_ALL_TIER,
  PRODUCT_GRID_AWAITING_CASH_STATUSES,
  PRODUCT_GRID_OTHERS_TIER,
  PRODUCT_GRID_RECEIVED_STATUSES,
  parseProductGridAnswer,
  productGridItemRefusal,
  productGridLines,
  productGridLinesOf,
  productGridTotalCents,
  productGridTotals,
  productGridView,
  type ProductGrid,
  type ProductGridLine,
} from './product-grid-contract';

/**
 * The priced grid's shared rule (`product-grid-contract.ts`, copied byte for byte into the frontend:
 * this spec proves both copies). Every definition refusal and every answer refusal, by its code.
 */

/** Hoodie: three colours x three sizes, one price, Creme closed in XS. */
const grid = (over: Partial<ProductGrid> = {}): ProductGrid => ({
  rows: [
    { id: 'vert', label: 'Vert' },
    { id: 'noir', label: 'Noir' },
    { id: 'creme', label: 'Creme' },
  ],
  columns: [
    { id: 'xs', label: 'XS' },
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
  ],
  maxPerCell: 5,
  closedCells: ['creme:xs'],
  pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 2800 } } },
  ...over,
});
const item = (g: unknown = grid(), required: unknown = true) => ({ required, productGrid: g });
const paidForm = { isPublic: false, requiresPayment: true };
const refusal = (g: unknown, form = paidForm, required: unknown = true) =>
  productGridItemRefusal(item(g, required), form)?.code ?? null;

describe('product grid contract - a definition', () => {
  it('accepts a complete grid in each price mode', () => {
    expect(refusal(grid())).toBeNull();
    expect(
      refusal(
        grid({
          pricing: {
            mode: 'per_row',
            tiers: null,
            prices: { _all: { vert: 2500, noir: 2500, creme: 3000 } },
          },
        })
      )
    ).toBeNull();
    expect(
      refusal(
        grid({
          pricing: {
            mode: 'per_column',
            tiers: null,
            prices: { _all: { xs: 2800, m: 2800, l: 3000 } },
          },
        })
      )
    ).toBeNull();
  });

  it('shares "everyone else" with the price grid', () => {
    expect(PRODUCT_GRID_OTHERS_TIER).toBe(OTHERS_BUCKET_ID);
  });

  it('refuses each defect with its own code', () => {
    expect(productGridItemRefusal({ required: true }, paidForm)?.code).toBe(
      'PRODUCT_GRID_DEFINITION_MISSING'
    );
    expect(refusal(grid(), paidForm, false)).toBe('PRODUCT_GRID_NOT_REQUIRED');
    expect(refusal(grid(), { isPublic: false, requiresPayment: false })).toBe(
      'PRODUCT_GRID_REQUIRES_PAYMENT'
    );
    expect(refusal(grid({ rows: [] }))).toBe('PRODUCT_GRID_AXIS_INVALID');
    expect(
      refusal(
        grid({ columns: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, label: `${i}` })) })
      )
    ).toBe('PRODUCT_GRID_AXIS_INVALID');
    expect(refusal(grid({ rows: [{ id: 'a:b', label: 'X' }] }))).toBe('PRODUCT_GRID_ID_INVALID');
    expect(refusal(grid({ rows: [{ id: '__proto__', label: 'X' }] }))).toBe(
      'PRODUCT_GRID_ID_INVALID'
    );
    expect(
      refusal(
        grid({
          rows: [
            { id: 'a', label: 'X' },
            { id: 'a', label: 'Y' },
          ],
        })
      )
    ).toBe('PRODUCT_GRID_DUPLICATE_ID');
    expect(refusal(grid({ rows: [{ id: 'a', label: '  ' }] }))).toBe('PRODUCT_GRID_LABEL_INVALID');
    expect(
      refusal(
        grid({
          columns: [
            { id: 'a', label: 'M' },
            { id: 'b', label: ' m ' },
          ],
        })
      )
    ).toBe('PRODUCT_GRID_DUPLICATE_LABEL');
    expect(refusal(grid({ maxPerCell: 0 }))).toBe('PRODUCT_GRID_MAX_PER_CELL_INVALID');
    expect(refusal(grid({ maxPerCell: 100 }))).toBe('PRODUCT_GRID_MAX_PER_CELL_INVALID');
    expect(refusal(grid({ maxPerCell: 2.5 }))).toBe('PRODUCT_GRID_MAX_PER_CELL_INVALID');
    expect(refusal(grid({ closedCells: ['rose:xs'] }))).toBe('PRODUCT_GRID_CLOSED_CELL_INVALID');
    expect(refusal(grid({ closedCells: ['vert:xs', 'vert:xs'] }))).toBe(
      'PRODUCT_GRID_CLOSED_CELL_INVALID'
    );
    expect(
      refusal(
        grid({
          rows: [{ id: 'vert', label: 'Vert' }],
          columns: [{ id: 'm', label: 'M' }],
          closedCells: ['vert:m'],
        })
      )
    ).toBe('PRODUCT_GRID_ALL_CELLS_CLOSED');
    expect(refusal(grid({ pricing: { mode: 'per_cell' as never, tiers: null, prices: {} } }))).toBe(
      'PRODUCT_GRID_PRICE_MODE_INVALID'
    );
    expect(
      refusal(
        grid({
          pricing: {
            mode: 'single',
            tiers: { id: 'd', kind: 'answer' as never, buckets: [{ id: 'a', label: 'A' }] },
            prices: {},
          },
        })
      )
    ).toBe('PRODUCT_GRID_TIER_INVALID');
    expect(
      refusal(grid({ pricing: { mode: 'per_row', tiers: null, prices: { _all: { vert: 1 } } } }))
    ).toBe('PRODUCT_GRID_PRICES_INCOMPLETE');
    expect(
      refusal(
        grid({ pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 1, xs: 1 } } } })
      )
    ).toBe('PRODUCT_GRID_PRICES_INCOMPLETE');
    expect(
      refusal(
        grid({
          pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 1 }, cot: { '*': 1 } } },
        })
      )
    ).toBe('PRODUCT_GRID_PRICES_INCOMPLETE');
    expect(
      refusal(grid({ pricing: { mode: 'single', tiers: null, prices: { _all: { '*': -1 } } } }))
    ).toBe('PRODUCT_GRID_PRICE_INVALID');
    expect(
      refusal(grid({ pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 9.5 } } } }))
    ).toBe('PRODUCT_GRID_PRICE_INVALID');
  });

  it('a public form needs the price a guest pays, named before the rest of completeness', () => {
    const tiered = (prices: Record<string, Record<string, number>>) =>
      grid({
        pricing: {
          mode: 'single',
          tiers: {
            id: 'cot',
            kind: 'cotisation',
            buckets: [{ id: 'cotisant', label: 'Cotisant', anyTier: true }],
          },
          prices,
        },
      });
    const pub = { isPublic: true, requiresPayment: true };
    expect(refusal(tiered({ cotisant: { '*': 2500 } }), pub)).toBe(
      'PRODUCT_GRID_GUEST_PRICE_MISSING'
    );
    expect(refusal(tiered({ cotisant: { '*': 2500 } }))).toBe('PRODUCT_GRID_PRICES_INCOMPLETE');
    expect(refusal(tiered({ cotisant: { '*': 2500 }, _others: { '*': 3000 } }), pub)).toBeNull();
  });
});

describe('product grid contract - an answer', () => {
  const g = grid();
  const code = (raw: unknown) => {
    const parsed = parseProductGridAnswer(g, raw);
    return parsed.ok ? null : (parsed as { code: string }).code;
  };

  it('keeps the ordered cells only, in grid order, and counts the units', () => {
    const parsed = parseProductGridAnswer(g, { 'noir:l': 1, 'vert:m': 2, 'vert:xs': 0 });
    expect(parsed).toEqual({ ok: true, answer: { 'vert:m': 2, 'noir:l': 1 }, units: 3 });
  });

  it('refuses each defect with its own code', () => {
    expect(code(undefined)).toBe('PRODUCT_GRID_ANSWER_MISSING');
    expect(code('')).toBe('PRODUCT_GRID_ANSWER_MISSING');
    expect(code(['vert:m'])).toBe('PRODUCT_GRID_ANSWER_MISSING');
    expect(code({ 'rose:m': 1 })).toBe('PRODUCT_GRID_UNKNOWN_CELL');
    expect(code(JSON.parse('{"__proto__": 1}'))).toBe('PRODUCT_GRID_UNKNOWN_CELL');
    expect(code({ 'vert:m': 6 })).toBe('PRODUCT_GRID_QUANTITY_INVALID');
    expect(code({ 'vert:m': -1 })).toBe('PRODUCT_GRID_QUANTITY_INVALID');
    expect(code({ 'vert:m': 1.5 })).toBe('PRODUCT_GRID_QUANTITY_INVALID');
    expect(code({ 'vert:m': '2' })).toBe('PRODUCT_GRID_QUANTITY_INVALID');
    expect(code({ 'creme:xs': 1 })).toBe('PRODUCT_GRID_CELL_CLOSED');
    expect(code({ 'creme:xs': 0, 'vert:m': 1 })).toBeNull();
    expect(code({})).toBe('PRODUCT_GRID_EMPTY');
    expect(code({ 'vert:m': 0 })).toBe('PRODUCT_GRID_EMPTY');
  });
});

describe('product grid contract - the lines', () => {
  const viewer = (prices: Record<string, number>, tierId = PRODUCT_GRID_ALL_TIER) => ({
    tierId,
    tierLabel: null,
    prices,
  });
  const answer = { 'vert:m': 2, 'noir:l': 1 };
  const priced = (mode: ProductGrid['pricing']['mode'], prices: Record<string, number>) =>
    productGridLines(
      { id: 'q1', label: 'Sweat', productGrid: { ...grid(), pricing: { mode } } },
      answer,
      viewer(prices)
    );

  it('single: every unit at the one price', () => {
    const lines = priced('single', { '*': 2800 });
    expect(
      lines.map((l) => [l.rowLabel, l.colLabel, l.quantity, l.unitCents, l.lineCents])
    ).toEqual([
      ['Vert', 'M', 2, 2800, 5600],
      ['Noir', 'L', 1, 2800, 2800],
    ]);
    expect(productGridTotalCents(lines)).toBe(8400);
  });

  it('per_row: each unit at its row price', () => {
    expect(productGridTotalCents(priced('per_row', { vert: 2500, noir: 2600, creme: 3000 }))).toBe(
      2 * 2500 + 2600
    );
  });

  it('per_column: each unit at its column price', () => {
    expect(productGridTotalCents(priced('per_column', { xs: 2000, m: 2800, l: 3000 }))).toBe(
      2 * 2800 + 3000
    );
  });

  it('throws on a price list that broke completeness, never a unit at 0', () => {
    expect(() => priced('per_row', { vert: 2500 })).toThrow(/no price for "noir"/);
  });

  it('a respondent view carries no price list', () => {
    expect(productGridView(grid()).pricing).toEqual({ mode: 'single' });
  });
});

describe('the totals rule - shared by the export and the responses screen', () => {
  const at = (
    rowId: string,
    colId: string,
    quantity: number,
    unitCents = 2800
  ): ProductGridLine => ({
    itemId: 'q',
    itemLabel: 'Sweat',
    rowId,
    rowLabel: rowId.toUpperCase(),
    colId,
    colLabel: colId.toUpperCase(),
    quantity,
    unitCents,
    lineCents: quantity * unitCents,
    tierId: PRODUCT_GRID_ALL_TIER,
    tierLabel: null,
  });
  const answers = [
    { paymentStatus: 'paid', lines: [at('vert', 'm', 2), at('noir', 'l', 1)] },
    { paymentStatus: 'pending_cash', lines: [at('vert', 'm', 1)] },
    { paymentStatus: 'refunded', lines: [at('vert', 'l', 4)] },
    { paymentStatus: 'cancelled', lines: [at('vert', 'l', 1)] },
    { paymentStatus: 'pending', lines: [at('noir', 'm', 1)] },
    { paymentStatus: 'free', lines: null },
  ];

  it('counts paid and free answers, and cash apart; never a refunded or cancelled one', () => {
    expect(productGridLinesOf(answers, PRODUCT_GRID_RECEIVED_STATUSES)).toHaveLength(2);
    expect(productGridLinesOf(answers, PRODUCT_GRID_AWAITING_CASH_STATUSES)).toEqual([
      at('vert', 'm', 1),
    ]);
    const both = productGridLinesOf(answers, [
      ...PRODUCT_GRID_RECEIVED_STATUSES,
      ...PRODUCT_GRID_AWAITING_CASH_STATUSES,
    ]);
    expect(both.some((l) => l.colId === 'l' && l.rowId === 'vert')).toBe(false);
  });

  it('sums per cell, per row, per column and in all, listing a deleted row from its lines', () => {
    const lines = [
      ...productGridLinesOf(answers, PRODUCT_GRID_RECEIVED_STATUSES),
      at('rose', 'm', 1),
    ];
    const totals = productGridTotals({ id: 'q', productGrid: grid() }, lines);
    expect(totals.rows.map((r) => r.id)).toEqual(['vert', 'noir', 'creme', 'rose']);
    expect(totals.cells['vert:m']).toEqual({ units: 2, cents: 5600 });
    expect(totals.cells['vert:l']).toBeUndefined();
    expect(totals.rowTotals.vert).toEqual({ units: 2, cents: 5600 });
    expect(totals.rowTotals.creme).toEqual({ units: 0, cents: 0 });
    expect(totals.columnTotals.m).toEqual({ units: 3, cents: 8400 });
    expect(totals.total).toEqual({ units: 4, cents: 11200 });
  });

  it('reads only the lines of its own question', () => {
    const other = { ...at('vert', 'm', 9), itemId: 'other' };
    expect(productGridTotals({ id: 'q', productGrid: grid() }, [other]).total.units).toBe(0);
  });
});
