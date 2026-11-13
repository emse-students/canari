import { describe, expect, it } from 'vitest';
import {
  GRID_REQUIRED_SWITCH,
  fromFormItems,
  revisionItems,
  toFormItemsPayload,
} from './itemsPayload';

describe('toFormItemsPayload', () => {
  it('turns a choice option supplement into cents', () => {
    const [item] = toFormItemsPayload([
      { id: 'q1', type: 'single_choice', options: [{ id: 'o1', label: 'A', priceModifier: 2.5 }] },
    ]);
    expect(item.options?.[0].priceModifier).toBe(250);
  });

  // A question turned into a matrix keeps its options as columns; their old supplements can never
  // charge, so they are not stored. Control (2026-10-22): the type check removed -> this fails.
  it('drops the supplements of a question that is no longer a choice', () => {
    const [item] = toFormItemsPayload([
      {
        id: 'q1',
        type: 'matrix_single',
        rows: ['r1'],
        options: [{ id: 'o1', label: 'Oui', priceModifier: 5 }],
      },
    ]);
    expect(item.options?.[0]).toMatchObject({ id: 'o1', priceModifier: 0 });
  });
});

describe('a priced grid on the wire', () => {
  const grid = () => ({
    rows: [{ id: 'r1', label: 'Vert' }],
    columns: [{ id: 'c1', label: 'M' }],
    maxPerCell: 3,
    closedCells: [],
    pricing: {
      mode: 'per_row',
      tiers: null,
      // A stale single price stays in the editor and never reaches the wire.
      prices: { _all: { '*': 20, r1: 28.5 } },
    },
  });

  it('carries the definition in the contract shape, in cents, with no options or rows', () => {
    const [item] = toFormItemsPayload([
      { id: 'g', type: 'product_grid', label: 'Sweat', required: true, productGrid: grid() },
    ]);
    expect(item.options).toEqual([]);
    expect(item.rows).toEqual([]);
    expect(item.productGrid).toEqual({
      rows: [{ id: 'r1', label: 'Vert' }],
      columns: [{ id: 'c1', label: 'M' }],
      maxPerCell: 3,
      closedCells: [],
      pricing: { mode: 'per_row', tiers: null, prices: { _all: { r1: 2850 } } },
    });
  });

  it('sends the "Obligatoire" switch of a grid as its card holds it', () => {
    const [off, on] = toFormItemsPayload([
      { id: 'g', type: 'product_grid', label: 'Sweat', required: false, productGrid: grid() },
      { id: 'h', type: 'product_grid', label: 'Veste', required: true, productGrid: grid() },
    ]);
    expect(off.required).toBe(false);
    expect(on.required).toBe(true);
  });

  it('every payload of this editor says it draws the switch', () => {
    expect(GRID_REQUIRED_SWITCH).toEqual({ gridRequiredSwitch: true });
  });

  it('[LEGACY] opens a revision an older editor saved with the STORED flag of each grid', () => {
    const stored = [
      { id: 'on', type: 'product_grid', label: 'Sweat', required: true },
      { id: 'off', type: 'product_grid', label: 'Veste', required: false },
    ] as any[];
    const document = {
      items: [
        { id: 'on', type: 'product_grid', label: 'Sweat', required: true },
        { id: 'off', type: 'product_grid', label: 'Veste', required: true },
        { id: 'new', type: 'product_grid', label: 'Mug', required: true },
        { id: 'nom', type: 'short_text', label: 'Nom', required: true },
      ],
    };
    expect(revisionItems(document, stored)?.map((item) => [item.id, item.required])).toEqual([
      ['on', true],
      ['off', false],
      ['new', false],
      ['nom', true],
    ]);
    // A revision this editor saved carries the switch: its flags are the manager's, as typed.
    const marked = { ...document, gridRequiredSwitch: true };
    expect(revisionItems(marked, stored)).toBe(document.items);
    expect(revisionItems({ title: 'x' } as any, stored)).toBeUndefined();
  });

  it('drops the definition of a question that is no longer a grid', () => {
    const [item] = toFormItemsPayload([
      { id: 'g', type: 'short_text', label: 'Sweat', required: true, productGrid: grid() },
    ]);
    expect('productGrid' in item).toBe(false);
  });

  it('reads the stored cents back as euros', () => {
    const [stored] = toFormItemsPayload([
      { id: 'g', type: 'product_grid', label: 'Sweat', required: true, productGrid: grid() },
    ]);
    const [back] = fromFormItems([stored], true);
    expect(back.productGrid.pricing.prices._all.r1).toBe(28.5);
  });
});
