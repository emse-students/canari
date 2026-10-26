import { m } from '$lib/paraglide/messages';
import { formatMoney } from '$lib/shop/money';
import type { AssociationProduct } from '$lib/associations/api';

/**
 * The price label of a free-amount product. A bound that is absent (or a minimum of 0, which bounds
 * nothing) is NOT printed: the card used to read "Libre (0-inf EUR)" for an unbounded product,
 * naming two figures the server never applied. Four wordings, one per combination, none plural.
 */
export function customAmountLabel(
  p: Pick<AssociationProduct, 'customAmountMinCents' | 'customAmountMaxCents' | 'currency'>
): string {
  const min = p.customAmountMinCents ? formatMoney(p.customAmountMinCents, p.currency) : null;
  const max = p.customAmountMaxCents ? formatMoney(p.customAmountMaxCents, p.currency) : null;
  if (min !== null && max !== null) return m.shop_price_libre({ min, max });
  if (min !== null) return m.shop_price_libre_min({ min });
  if (max !== null) return m.shop_price_libre_max({ max });
  return m.shop_price_libre_open();
}
