import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { formatMoney } from '$lib/shop/money';
import { customAmountLabel } from './customAmountLabel';

const p = (min: number | null, max: number | null) => ({
  customAmountMinCents: min,
  customAmountMaxCents: max,
  currency: 'eur',
});

describe('customAmountLabel', () => {
  it('prints no bound at all when the product has neither', () => {
    expect(customAmountLabel(p(null, null))).toBe(m.shop_price_libre_open());
    // A minimum of 0 bounds nothing, so it is not printed either.
    expect(customAmountLabel(p(0, null))).toBe(m.shop_price_libre_open());
    expect(customAmountLabel(p(null, null))).not.toMatch(/inf|∞|0\.00/i);
  });

  it('prints only the bound that exists, in the locale money format', () => {
    expect(customAmountLabel(p(500, null))).toBe(
      m.shop_price_libre_min({ min: formatMoney(500, 'eur') })
    );
    expect(customAmountLabel(p(null, 5000))).toBe(
      m.shop_price_libre_max({ max: formatMoney(5000, 'eur') })
    );
  });

  it('CONTROL: a product with both bounds keeps the range wording', () => {
    expect(customAmountLabel(p(100, 5000))).toBe(
      m.shop_price_libre({ min: formatMoney(100, 'eur'), max: formatMoney(5000, 'eur') })
    );
  });
});
