import { getLocale } from '$lib/paraglide/runtime';
import { formatAmountCents } from '$lib/shop/amountInput';

/**
 * An amount of cents as the reader's locale writes money (`15,00 EUR` in French), through Intl.
 * The ONE price formatter of the shop: a `toFixed(2)` printed `15.00 EUR` to a French reader.
 */
export function formatMoney(cents: number, currency: string): string {
  return formatAmountCents(cents, currency, getLocale());
}
