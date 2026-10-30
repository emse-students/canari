import type { AssociationProduct } from '$lib/associations/api';
import { tierRankCents } from '$lib/associations/cotisationTiers';
import { customAmountLabel } from '$lib/associations/customAmountLabel';
import { formatAmount } from '$lib/forms/fillAnswers';
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
  return formatAmount(price.amountCents, product.currency);
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
  return linkedTier(product, siblings)?.name ?? null;
}

/** The sibling tier product `linkedTierName` names, or null (same rules). */
function linkedTier(
  product: AssociationProduct,
  siblings: readonly AssociationProduct[]
): AssociationProduct | null {
  if (!product.memberPriceTag || product.memberPriceTierKey === undefined) return null;
  return (
    siblings.find((s) => s.type === 'membership' && s.variantKey === product.memberPriceTierKey) ??
    null
  );
}

/**
 * The preferential price label for this viewer (`preferentialDueCents`), or null when they pay the
 * full price. Formatted like the shop's other prices.
 */
export function preferentialPriceLabel(product: AssociationProduct): string | null {
  const due = preferentialDueCents(product);
  return due === null ? null : formatAmount(due, product.currency);
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

/**
 * The preferential price OTHER buyers get, for a viewer who pays the full price - "5,00 EUR for
 * holders of Cotisation" - or null. Information only, never what this viewer is charged: that is
 * `viewerDueCents`, and when it already is the preferential price (`preferentialDueCents`) the
 * struck-through rendering says it instead. The amount is the stored `amountCentsMember` the
 * checkout charges a qualifying buyer (`fixedPriceFor`); who qualifies stays the server's decision.
 *
 * A tag-linked price shows only when the server named its tier (`linkedTierName`): a link it could
 * not read applies no preferential price server-side, so announcing one would be false; and only when
 * that tier has a single price, since an unrankable one is refused every rise. Null for a grid (it
 * replaces the fixed pricing) or a free amount.
 */
export function memberOfferLabel(
  product: AssociationProduct,
  siblings: readonly AssociationProduct[]
): string | null {
  const member = product.amountCentsMember;
  if (product.priceMatrix != null || product.amountCents === null || member == null) return null;
  if (member <= 0 || member >= product.amountCents) return null;
  if (preferentialDueCents(product) !== null) return null;
  const amount = formatAmount(member, product.currency);
  if (!product.memberPriceTag) return m.shop_member_offer_cotisants({ amount });
  const tier = linkedTier(product, siblings);
  // A linked tier that cannot be ranked (a grid, or a named tier with no price - `rankPriceCents` in
  // social-service `tier-pricing.ts`): its holders are refused every rise as `unranked`, so nobody
  // can ever pay this member price and announcing it would be false. An unpriced BASE tier ranks
  // lowest and IS rankable.
  if (tier === null || tierRankCents(tier) === null) return null;
  return m.shop_member_offer_tier({ amount, tier: tier.name });
}

/**
 * The full (non-preferential) price label for a product: a grid's cell first and alone, else the
 * fixed `amountCents` formatted in the reader's locale, else the free-amount wording, else "free".
 * ONE implementation for the shop page and the association page, which each wrote this chain
 * inline and separately before - `priceLabel` here and a `{#if}` chain there, both re-deriving the
 * same four-way fallback and one of them still spelling the amount with `toFixed(2)`.
 */
export function fullPriceLabel(product: AssociationProduct): string {
  const gridded = gridPriceLabel(product);
  if (gridded !== null) return gridded;
  if (product.amountCents !== null) return formatAmount(product.amountCents, product.currency);
  if (product.allowCustomAmount) return customAmountLabel(product);
  return m.shop_price_free();
}
