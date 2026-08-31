import type { AssociationProduct } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';

/**
 * Rendering a price the SERVER resolved for the person looking at the screen.
 *
 * A gridded product has no single price to print: what it costs depends on the viewer's promotion,
 * programme and cotisation, and only the server holds those facts (the client is never told another
 * user's profile, and must not be trusted about its own). So the listing endpoints annotate each
 * product with a `viewerPrice`, and these helpers are the ONLY readers of it - the two listings that
 * exist would otherwise each re-derive "is there a grid, did it refuse, what does it say", and the
 * third one written would get it subtly wrong.
 *
 * A product with no grid has no `viewerPrice` worth reading: every helper here answers "not mine",
 * and the caller's existing fixed-price rendering stands.
 */

/**
 * True when a grid decided this viewer may not buy this product AT ALL.
 *
 * A null cell is a REFUSAL, never a price of zero: it is how "non-cotisant, formule week-end" stops
 * being offered. The server rejects the checkout either way, so this only keeps the screen from
 * offering a button whose every press fails.
 */
export function gridRefuses(product: AssociationProduct): boolean {
  const price = product.viewerPrice;
  return price?.kind === 'grid' && price.amountCents === null;
}

/**
 * The price label a grid produces for this viewer, or null when no grid prices this product.
 *
 * Null is the signal to fall back to the product's own fixed price - not a fallback PATH, but the
 * ordinary answer for the products that never had a grid.
 */
export function gridPriceLabel(product: AssociationProduct): string | null {
  const price = product.viewerPrice;
  if (price?.kind !== 'grid') return null;
  if (price.amountCents === null) return m.shop_price_unavailable();
  return `${(price.amountCents / 100).toFixed(2)} ${product.currency.toUpperCase()}`;
}

/**
 * True when the figure shown is the "everyone else" cell because nobody is signed in.
 *
 * The grid rests on facts a signed-out visitor has not supplied, so the price on screen is honest
 * but provisional, and saying so is cheaper than a surprise at checkout.
 */
export function gridPriceIsProvisional(product: AssociationProduct, signedIn: boolean): boolean {
  return !signedIn && product.viewerPrice?.kind === 'grid' && product.viewerPrice.dependsOnProfile;
}
