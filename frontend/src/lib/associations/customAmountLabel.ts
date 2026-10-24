import { m } from '$lib/paraglide/messages';
import type { AssociationProduct } from '$lib/associations/api';

/**
 * The price label of a free-amount product. A bound that is absent (or a minimum of 0, which bounds
 * nothing) is NOT printed: the card used to read "Libre (0-inf EUR)" for an unbounded product,
 * naming two figures the server never applied. Four wordings, one per combination, none plural.
 */
export function customAmountLabel(
  p: Pick<AssociationProduct, 'customAmountMinCents' | 'customAmountMaxCents' | 'currency'>
): string {
  const currency = p.currency.toUpperCase();
  const min = p.customAmountMinCents ? (p.customAmountMinCents / 100).toFixed(2) : null;
  const max = p.customAmountMaxCents ? (p.customAmountMaxCents / 100).toFixed(2) : null;
  if (min !== null && max !== null) return m.shop_price_libre({ min, max, currency });
  if (min !== null) return m.shop_price_libre_min({ min, currency });
  if (max !== null) return m.shop_price_libre_max({ max, currency });
  return m.shop_price_libre_open();
}
