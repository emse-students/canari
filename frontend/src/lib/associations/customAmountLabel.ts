import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { AssociationProduct } from '$lib/associations/api';

/**
 * A bound in cents as the reader's locale writes the number (`15,00` in French, `15.00` in
 * English) - no currency symbol, since the sentence names the currency itself as `{currency}`.
 * `toFixed(2)` always spells the decimal point `.`, which read wrong to a French reader; this
 * keeps the existing `{min} {currency}` / `{max} {currency}` wording untouched.
 */
function formatDecimal(cents: number): string {
  return new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * The price label of a free-amount product. A bound that is absent (or a minimum of 0, which bounds
 * nothing) is NOT printed: the card used to read "Libre (0-inf EUR)" for an unbounded product,
 * naming two figures the server never applied. Four wordings, one per combination, none plural.
 */
export function customAmountLabel(
  p: Pick<AssociationProduct, 'customAmountMinCents' | 'customAmountMaxCents' | 'currency'>
): string {
  const currency = p.currency.toUpperCase();
  const min = p.customAmountMinCents ? formatDecimal(p.customAmountMinCents) : null;
  const max = p.customAmountMaxCents ? formatDecimal(p.customAmountMaxCents) : null;
  if (min !== null && max !== null) return m.shop_price_libre({ min, max, currency });
  if (min !== null) return m.shop_price_libre_min({ min, currency });
  if (max !== null) return m.shop_price_libre_max({ max, currency });
  return m.shop_price_libre_open();
}
