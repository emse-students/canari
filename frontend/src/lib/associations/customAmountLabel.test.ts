import { describe, expect, it, afterEach } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { setLocale } from '$lib/paraglide/runtime';
import { customAmountLabel } from './customAmountLabel';

const p = (min: number | null, max: number | null) => ({
  customAmountMinCents: min,
  customAmountMaxCents: max,
  currency: 'eur',
});

// `src/test/locale.ts` resets every test to `baseLocale` ('fr') before it runs, so the bare
// assertions below are already in the reader's locale - a comma, never the ASCII dot `toFixed(2)`
// used to write regardless of who was reading.
describe('customAmountLabel', () => {
  it('prints no bound at all when the product has neither', () => {
    expect(customAmountLabel(p(null, null))).toBe(m.shop_price_libre_open());
    // A minimum of 0 bounds nothing, so it is not printed either.
    expect(customAmountLabel(p(0, null))).toBe(m.shop_price_libre_open());
    expect(customAmountLabel(p(null, null))).not.toMatch(/inf|∞|0[.,]00/i);
  });

  it('prints only the bound that exists, comma-decimal in the base (French) locale', () => {
    expect(customAmountLabel(p(500, null))).toBe(
      m.shop_price_libre_min({ min: '5,00', currency: 'EUR' })
    );
    expect(customAmountLabel(p(null, 5000))).toBe(
      m.shop_price_libre_max({ max: '50,00', currency: 'EUR' })
    );
  });

  it('CONTROL: a product with both bounds keeps the range wording', () => {
    expect(customAmountLabel(p(100, 5000))).toBe(
      m.shop_price_libre({ min: '1,00', max: '50,00', currency: 'EUR' })
    );
  });

  describe('the bound reads in the reader locale', () => {
    afterEach(() => setLocale('fr', { reload: false }));

    it('spells the decimal point the way English does: a period, once the reader is English', () => {
      setLocale('en', { reload: false });
      // `toFixed(2)` always wrote the ASCII dot, which happened to read right in English and wrong
      // in French; proving BOTH directions is what tells the two apart.
      expect(customAmountLabel(p(500, null))).toBe(
        m.shop_price_libre_min({ min: '5.00', currency: 'EUR' })
      );
    });
  });
});
