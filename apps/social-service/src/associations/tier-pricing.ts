/**
 * The two money decisions a cotisation tier sale rests on, as pure functions shared by the checkout
 * (`ProductsService.resolvePurchase`) and the shop listing (`listAllActive`), so the price a viewer
 * is QUOTED and the price a checkout CHARGES are one computation (docs/wiki/cotisations.md
 * "Rising to a higher tier").
 */

/**
 * Where a tier product stands against the tier the viewer holds ACTIVE in the same association.
 *
 * - `held`: that very tier (same `variantKey`).
 * - `higher`: a rise - the product price is strictly greater than the held tier's.
 * - `lower`: NOT a rise - the product price is lower than or EQUAL to the held tier's. Buying it would
 *   replace the held tier through the sibling XOR, i.e. a silent downgrade, so the checkout refuses it.
 * - `none`: nothing held, or one of the two tiers has no fixed price (a grid or a free amount) and
 *   so no rank the server could defend - today's behaviour is kept rather than a rank guessed.
 */
export type TierRelation = 'held' | 'lower' | 'higher' | 'none';

/** The columns a tier is ranked on: the PRODUCT price, never what a holder happened to pay. */
export interface RankedTier {
  variantKey: string | null;
  amountCents: number | null;
  priceMatrix?: unknown;
}

/**
 * The tier a viewer holds: its `variantKey`, and its product when one still exists (an association
 * with no membership product at all still recognizes the base tag, so `product` may be null).
 */
export interface HeldTier {
  variantKey: string | null;
  product: RankedTier | null;
}

/** True when a tier has one price for everybody, so it can be ranked. */
function hasFixedPrice(t: RankedTier): t is RankedTier & { amountCents: number } {
  return t.priceMatrix == null && t.amountCents !== null;
}

/**
 * Ranks `target` (a membership product of the held tier's association) against `held`. Rank is
 * derived from data - the product price - with no stored ordinal: `variantLevel` is null in
 * production and only ever sorted the shop.
 */
export function tierRelation(target: RankedTier, held: HeldTier | null): TierRelation {
  if (!held) return 'none';
  if (target.variantKey === held.variantKey) return 'held';
  if (!held.product || !hasFixedPrice(target) || !hasFixedPrice(held.product)) return 'none';
  return target.amountCents > held.product.amountCents ? 'higher' : 'lower';
}

/** The pricing columns of a product with one price for everybody (no grid). */
export interface FixedPricedProduct {
  amountCents: number;
  amountCentsMember: number | null;
  memberPriceTag: string | null;
}

/**
 * The amount a fixed-price product charges one buyer. The preferential price (`amountCentsMember`)
 * applies when the buyer qualifies: holding `memberPriceTag` when the admin set one ("Tarif
 * preferentiel depuis" a sibling tier - which is how a rise costs only the complement), else being
 * a cotisant of the association at all. Nothing is computed from tier prices: the complement IS the
 * admin's preferential price, and a tier without one is charged in full.
 */
export function fixedPriceFor(
  product: FixedPricedProduct,
  buyer: { isCotisant: boolean; holdsMemberPriceTag: boolean }
): { amountCents: number; preferential: boolean } {
  const qualifies = product.memberPriceTag ? buyer.holdsMemberPriceTag : buyer.isCotisant;
  if (qualifies && product.amountCentsMember != null) {
    return { amountCents: product.amountCentsMember, preferential: true };
  }
  return { amountCents: product.amountCents, preferential: false };
}
