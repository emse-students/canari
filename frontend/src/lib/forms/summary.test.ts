import { describe, expect, it } from 'vitest';
import { formSummary } from './summary';
import { emptyMatrix, type PriceMatrix } from '$lib/pricing/priceMatrix';

/**
 * The save bar's one line. It exists because the two editor screens had drifted: the create page
 * printed the price and the edit page printed only the question count, so the same form summarised
 * itself two ways depending on which door you came in by.
 *
 * The wording is Paraglide's; what is asserted here is the FIGURE, which is where a drift would be.
 */
describe('form summary', () => {
  const grid = (cells: Record<string, number | null>): PriceMatrix => ({
    ...emptyMatrix(0),
    dimensions: [{ id: 'c', kind: 'cotisation', buckets: [{ id: 'yes', label: 'Cotisant' }] }],
    cells,
  });

  it('says a free form is free, whatever the price field holds', () => {
    const line = formSummary({
      questionCount: 3,
      requiresPayment: false,
      basePrice: 20,
      priceMatrix: null,
    });
    expect(line).not.toContain('20');
  });

  it('prints the single price of a paid form', () => {
    expect(
      formSummary({ questionCount: 3, requiresPayment: true, basePrice: 20, priceMatrix: null })
    ).toContain('20');
  });

  // Nothing worth saying: a paid form whose price is still 0 is a form mid-edit, not a free one.
  it('stays silent on a paid form with no price yet', () => {
    expect(
      formSummary({ questionCount: 1, requiresPayment: true, basePrice: 0, priceMatrix: null })
    ).not.toContain('0');
  });

  // A grid has no single price, so the summary is a range - the same shape the fill page shows.
  it('prints a range for a grid with two prices', () => {
    const line = formSummary({
      questionCount: 2,
      requiresPayment: true,
      basePrice: 99,
      priceMatrix: grid({ yes: 8, _others: 20 }),
    });
    expect(line).toContain('8');
    expect(line).toContain('20');
    expect(line).not.toContain('99');
  });

  it('prints one figure when every cell of the grid agrees', () => {
    const line = formSummary({
      questionCount: 2,
      requiresPayment: true,
      basePrice: 0,
      priceMatrix: grid({ yes: 12, _others: 12 }),
    });
    expect(line.match(/12/g)).toHaveLength(1);
  });

  // An unavailable cell is not a price of zero, so it must not drag the range down to it.
  it('ignores unavailable cells in the range', () => {
    const line = formSummary({
      questionCount: 2,
      requiresPayment: true,
      basePrice: 0,
      priceMatrix: grid({ yes: 12, _others: null }),
    });
    expect(line.match(/12/g)).toHaveLength(1);
  });
});
