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

/** Why a membership product is not offered to this viewer (`tierNotOffered`). */
export type TierNotOffered = 'disabled' | 'held' | 'lower' | 'unranked';

/**
 * Why the shop offers NO purchase of this membership product to this viewer, read from the
 * server's annotations, or null when it is offered: `disabled` (its association's cotisations are
 * disabled, `cotisationDisabled`), else the server's `viewerTierRelation` - `held` (that very tier),
 * `lower` (not a rise over the tier held), `unranked` (no rank can be established). Each is refused
 * by the checkout with a 409, so the screen offers no button whose every press fails. Nothing is
 * re-derived here: the server holds the tiers' prices, the viewer's tags and the association's mode.
 */
export function tierNotOffered(product: AssociationProduct): TierNotOffered | null {
  if (product.cotisationDisabled) return 'disabled';
  const relation = product.viewerTierRelation;
  return relation === 'held' || relation === 'lower' || relation === 'unranked' ? relation : null;
}

/** The sentence for a membership product not offered to this viewer (`tierNotOffered`). */
export function tierNotOfferedText(reason: TierNotOffered): string {
  switch (reason) {
    case 'disabled':
      return m.shop_cotisation_disabled();
    case 'held':
      return m.shop_tier_held_hint();
    case 'lower':
      return m.shop_tier_not_a_rise();
    case 'unranked':
      return m.shop_tier_not_rankable();
  }
}

/**
 * The name of the tier a tier-linked (`memberPriceTag`) preferential price is for - the one the
 * server read the tag as naming (`memberPriceTierKey`), never the first tier the viewer holds,
 * which for a viewer holding two is not always it - or null for the association-wide cotisant
 * price, or when the server named no tier. Wording only: whether the price applies is the server's
 * decision, already in `viewerDueCents`. `siblings` are the products of the same association.
 */
export function linkedTierName(
  product: AssociationProduct,
  siblings: readonly AssociationProduct[]
): string | null {
  if (!product.memberPriceTag || product.memberPriceTierKey === undefined) return null;
  return (
    siblings.find((s) => s.type === 'membership' && s.variantKey === product.memberPriceTierKey)
      ?.name ?? null
  );
}

/**
 * The preferential price label for this viewer (`preferentialDueCents`), or null when they pay the
 * full price. Formatted like the shop's other prices.
 */
export function preferentialPriceLabel(product: AssociationProduct): string | null {
  const due = preferentialDueCents(product);
  return due === null ? null : `${(due / 100).toFixed(2)} ${product.currency.toUpperCase()}`;
}

/**
 * The preferential amount this viewer pays for a fixed-price product, in cents, or null when they
 * pay the full price (or the product has a grid, a free amount, or no price for them). Read from
 * the server's `viewerDueCents` - the amount the checkout charges - and NEVER computed from the
 * product's member-price columns: whether the viewer qualifies rests on tags only the server reads.
 */
export function preferentialDueCents(product: AssociationProduct): number | null {
  const due = product.viewerDueCents;
  if (product.priceMatrix != null || product.amountCents === null || due == null) return null;
  return due < product.amountCents ? due : null;
}
