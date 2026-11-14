import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import type { FormItem } from './api';
import { fillPriceState } from './fillPricing';
import type { ProductGridPrices, ProductGridView } from './productGridContract';
import {
  appliedTierLabels,
  cellQuantity,
  hasOrderedUnits,
  lowestUnitCents,
  orderLineLabel,
  orderUnitCount,
  productGridOrderLines,
  productGridRefusalMessage,
  withCellQuantity,
} from './productGridFill';

/**
 * A PRICED GRID ON A FILL PAGE: what a click does to the answer, and what the page totals. The
 * contract's own rules (the answer judged, a line priced) are tested beside the server copy; these
 * are the page's uses of them.
 */
const hoodie: ProductGridView = {
  rows: [
    { id: 'noir', label: 'Noir' },
    { id: 'vert', label: 'Vert' },
  ],
  columns: [
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
  ],
  maxPerCell: 5,
  closedCells: ['vert:m'],
  pricing: { mode: 'single' },
};
const jacket: ProductGridView = {
  rows: [{ id: 'taille', label: 'Taille' }],
  columns: [
    { id: 's', label: 'S' },
    { id: 'xl', label: 'XL' },
  ],
  maxPerCell: 3,
  closedCells: [],
  pricing: { mode: 'per_column' },
};
const items: FormItem[] = [
  {
    id: 'q_hoodie',
    label: 'Sweat capuche',
    required: true,
    type: 'product_grid',
    productGrid: hoodie,
  },
  { id: 'q_note', label: 'Remarque', required: false, type: 'short_text' },
  { id: 'q_jacket', label: 'Veste', required: true, type: 'product_grid', productGrid: jacket },
];
const prices: ProductGridPrices = {
  q_hoodie: { tierId: 'cotisant', tierLabel: 'Cotisant BDE', prices: { '*': 2800 } },
  q_jacket: { tierId: '_all', tierLabel: null, prices: { s: 3000, xl: 3500 } },
};

afterEach(() => vi.restoreAllMocks());

describe('withCellQuantity', () => {
  it('sets a cell, clamps it to 0..maxPerCell and drops a cell back at 0', () => {
    let answer = withCellQuantity({}, hoodie, 'noir', 'm', 1);
    expect(answer).toEqual({ 'noir:m': 1 });
    answer = withCellQuantity(answer, hoodie, 'noir', 'm', 9);
    expect(answer).toEqual({ 'noir:m': 5 });
    answer = withCellQuantity(answer, hoodie, 'noir', 'l', -1);
    expect(answer).toEqual({ 'noir:m': 5 });
    answer = withCellQuantity(answer, hoodie, 'noir', 'm', 0);
    expect(answer).toEqual({});
  });

  it('returns a new object, so a bound value sees the write', () => {
    const before = { 'noir:m': 1 };
    const after = withCellQuantity(before, hoodie, 'noir', 'm', 2);
    expect(after).not.toBe(before);
    expect(before).toEqual({ 'noir:m': 1 });
  });

  it('reads a malformed answer as empty', () => {
    expect(cellQuantity('', 'noir', 'm')).toBe(0);
    expect(cellQuantity({ 'noir:m': 'x' }, 'noir', 'm')).toBe(0);
    expect(hasOrderedUnits({ 'noir:m': 0 })).toBe(false);
    expect(hasOrderedUnits(['noir:m'])).toBe(false);
  });
});

describe('the order across every grid', () => {
  it('prices each grid at its own list and totals them, in the form order', () => {
    const selections = { q_hoodie: { 'noir:m': 2, 'vert:l': 1 }, q_jacket: { 'taille:xl': 1 } };
    const lines = productGridOrderLines(items, selections, prices);
    expect(lines.map((l) => [l.itemId, l.rowId, l.colId, l.quantity, l.lineCents])).toEqual([
      ['q_hoodie', 'noir', 'm', 2, 5600],
      ['q_hoodie', 'vert', 'l', 1, 2800],
      ['q_jacket', 'taille', 'xl', 1, 3500],
    ]);
    expect(orderUnitCount(lines)).toBe(4);
    expect(orderLineLabel(lines[0], items)).toBe('Sweat capuche Noir M');
    // A one-row grid has no row label on screen, nor in its recap line.
    expect(orderLineLabel(lines[2], items)).toBe('Veste XL');

    const state = fillPriceState({
      basePrice: 0,
      pricing: null,
      items,
      visibleItems: items,
      selections,
      productGridPrices: prices,
    });
    expect(state.gridCents).toBe(11900);
    expect(state.total).toBe(11900);
  });

  it('adds the grids to the base price and the supplements, as the server does', () => {
    const state = fillPriceState({
      basePrice: 500,
      pricing: null,
      items,
      visibleItems: items,
      selections: { q_hoodie: { 'noir:l': 1 }, q_jacket: {} },
      productGridPrices: prices,
    });
    expect(state.total).toBe(3300);
  });

  it('leaves a hidden grid out of the total', () => {
    const lines = productGridOrderLines(
      items.filter((i) => i.id !== 'q_jacket'),
      { q_hoodie: { 'noir:m': 1 }, q_jacket: { 'taille:s': 3 } },
      prices
    );
    expect(lines.map((l) => l.itemId)).toEqual(['q_hoodie']);
  });

  it('totals nothing for a grid the server sent no prices for, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines = productGridOrderLines(items, { q_hoodie: { 'noir:m': 1 } }, {});
    expect(lines).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('q_hoodie has no prices'));
  });

  it('totals nothing for an answer the contract refuses (a closed cell), and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(productGridOrderLines(items, { q_hoodie: { 'vert:m': 1 } }, prices)).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('PRODUCT_GRID_CELL_CLOSED'));
  });
});

describe('prices and categories as the page words them', () => {
  it('reads the lowest open cell as the "from" price', () => {
    expect(lowestUnitCents(jacket, prices.q_jacket)).toBe(3000);
    expect(lowestUnitCents(jacket, undefined)).toBeNull();
  });

  it('names each category once, "everyone else" in words, and nothing for one list', () => {
    expect(appliedTierLabels(items, prices)).toEqual(['Cotisant BDE']);
    expect(
      appliedTierLabels(items, {
        q_hoodie: { tierId: '_others', tierLabel: null, prices: { '*': 3100 } },
        q_jacket: { tierId: '_others', tierLabel: null, prices: { s: 1, xl: 1 } },
      })
    ).toEqual([m.form_criterion_others()]);
    expect(appliedTierLabels(items, { q_jacket: prices.q_jacket })).toEqual([]);
  });
});

describe('productGridRefusalMessage', () => {
  it('words every answer refusal of the contract, and nothing else', () => {
    expect(productGridRefusalMessage('PRODUCT_GRID_ANSWER_MISSING')).toBe(
      m.form_refusal_grid_update_app()
    );
    for (const code of [
      'PRODUCT_GRID_UNKNOWN_CELL',
      'PRODUCT_GRID_QUANTITY_INVALID',
      'PRODUCT_GRID_CELL_CLOSED',
    ]) {
      expect(productGridRefusalMessage(code)).toBe(m.form_refusal_grid_changed());
    }
    // The empty ORDER is no refusal of a current estate (owner, 2026-11-13), but an estate older than
    // each grid's switch still says it, so its words stay ([LEGACY]).
    expect(productGridRefusalMessage('PRODUCT_GRID_EMPTY')).toBe(m.form_refusal_grid_empty());
    expect(productGridRefusalMessage('FORM_FULL')).toBeNull();
    expect(productGridRefusalMessage(null)).toBeNull();
  });
});
