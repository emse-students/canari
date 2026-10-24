import { describe, expect, it, vi } from 'vitest';
import { OTHERS_BUCKET_ID } from '$lib/pricing/priceMatrix';
import type { FormItem, PricingView } from './api';
import { bucketIdOf, fillPriceState, optionModifierOf } from './fillPricing';

/**
 * The price both fill pages show (member and guest). Moved out of the member page so the guest page
 * totals with the SAME rule: these are the cases that page relied on.
 */
const menu: FormItem = {
  id: 'q_menu',
  label: 'Menu',
  required: true,
  type: 'single_choice',
  options: [
    { id: 'opt_veg', label: 'Vegetarien', priceModifier: 0 },
    { id: 'opt_meat', label: 'Viande', priceModifier: 200 },
    { id: 'opt_fish', label: 'Poisson', priceModifier: 0 },
  ],
} as FormItem;
const extras: FormItem = {
  id: 'q_extras',
  label: 'Extras',
  required: false,
  type: 'multiple_choice',
  options: [
    { id: 'opt_wine', label: 'Vin', priceModifier: 300 },
    { id: 'opt_cake', label: 'Gateau', priceModifier: 150 },
  ],
} as FormItem;

const grid: PricingView = {
  baseCents: 1800,
  appliedLabels: [],
  answerDimensions: [
    {
      id: 'menu',
      questionId: 'q_menu',
      buckets: [
        { id: 'veg', label: 'Vegetarien', values: ['opt_veg'] },
        { id: 'meat', label: 'Viande', values: ['opt_meat'] },
      ],
    },
  ],
  cells: { veg: 1000, meat: 1200, [OTHERS_BUCKET_ID]: null },
  ignoredModifierQuestionIds: ['q_menu'],
};

const state = (selections: Record<string, unknown>, pricing: PricingView | null = grid) =>
  fillPriceState({
    basePrice: 900,
    pricing,
    items: [menu, extras],
    visibleItems: [menu, extras],
    selections: selections as never,
  });

describe('fillPriceState', () => {
  it('totals a single price and the supplements chosen', () => {
    const s = state({ q_menu: 'opt_meat', q_extras: ['opt_wine', 'opt_cake'] }, null);
    expect(s.baseCents).toBe(900);
    expect(s.total).toBe(900 + 200 + 300 + 150);
    expect(s.appliedLabel).toBe('');
  });

  it('takes the cell the answers land on, and no supplement for the question it prices', () => {
    const s = state({ q_menu: 'opt_meat', q_extras: ['opt_wine'] });
    expect(s.baseCents).toBe(1200);
    expect(s.total).toBe(1200 + 300);
    expect(optionModifierOf(s, menu, { priceModifier: 200 })).toBe(0);
    expect(optionModifierOf(s, extras, { priceModifier: 300 })).toBe(300);
  });

  it('says nothing about the price until the priced question is answered', () => {
    const s = state({});
    expect(s.priceDecided).toBe(false);
    expect(s.priceUnavailable).toBe(false);
    expect(s.total).toBe(0);
  });

  it('reports a combination that does not exist, and the option that leads there', () => {
    const s = state({ q_menu: 'opt_fish' });
    expect(s.priceUnavailable).toBe(true);
    expect(s.total).toBe(0);
    expect(state({ q_menu: 'opt_veg' }).unavailableOptionIds).toEqual(new Set(['opt_fish']));
  });

  it('treats a cell the slice does not carry as unavailable, loudly', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = state({ q_menu: 'opt_veg' }, { ...grid, cells: { meat: 1200 } });
    expect(s.priceUnavailable).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no cell "veg"'));
    error.mockRestore();
  });

  it('names the groups the server matched', () => {
    expect(
      state({ q_menu: 'opt_veg' }, { ...grid, appliedLabels: ['Cotisant'] }).appliedLabel
    ).toBe(' (Cotisant)');
  });
});

describe('bucketIdOf', () => {
  it('falls in "others" when no group holds the answer', () => {
    expect(bucketIdOf(grid.answerDimensions[0], 'opt_fish')).toBe(OTHERS_BUCKET_ID);
    expect(bucketIdOf(grid.answerDimensions[0], ['opt_meat'])).toBe('meat');
  });
});
