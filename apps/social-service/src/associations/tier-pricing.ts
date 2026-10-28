import { deriveCotisationTag } from './cotisation-tag.util';

/**
 * The money decisions a cotisation tier sale rests on, as pure functions shared by the checkout
 * (`ProductsService.resolvePurchase`), its settlement and the shop listings, so the price a viewer is
 * QUOTED and the price a checkout CHARGES are one computation (docs/wiki/cotisations.md
 * "Rising to a higher tier").
 */

/**
 * Where a tier product stands against the tier the viewer holds ACTIVE in the same association.
 *
 * - `none`: nothing held - sold as any product.
 * - `held`: that very tier (same `variantKey`) - not sold again.
 * - `higher`: a rise - its product price is strictly greater than the held tier's - sold.
 * - `lower`: NOT a rise - its product price is lower than or EQUAL to the held tier's - refused, since
 *   the sibling XOR would replace the held tier.
 * - `unranked`: a tier is held, but it or the target has no fixed price (a grid, a free amount, a tag
 *   whose tier product is gone), so no rank can be defended - refused rather than guessed.
 */
export type TierRelation = 'none' | 'held' | 'higher' | 'lower' | 'unranked';

/** The columns a tier is ranked on: the PRODUCT price, never what a holder happened to pay. */
export interface RankedTier {
  variantKey: string | null;
  amountCents: number | null;
  priceMatrix?: unknown;
}

/**
 * A tier a viewer holds: its `variantKey`, and its product when one still exists (a tag can outlive
 * its tier product, so `product` may be null).
 */
export interface HeldTier {
  variantKey: string | null;
  product: RankedTier | null;
}

/** True when a tier has one price for everybody, so it can be ranked. */
function hasFixedPrice(t: RankedTier | null): t is RankedTier & { amountCents: number } {
  return t !== null && t.priceMatrix == null && t.amountCents !== null;
}

/** Named keys in code-point order, the base tier (`null`) last: a total order on `variantKey`. */
function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * The ONE held tier a purchase is ranked against, when a viewer holds several tier tags at once (a
 * legacy base tag beside a named one). Deterministic whatever order the rows were read in:
 *
 * - any held tier that cannot be ranked wins (the first by `compareKeys`), so the sale is refused
 *   as `unranked` rather than ranked against a convenient sibling;
 * - otherwise the DEAREST held tier, ties broken by `compareKeys` - ranking against the most
 *   valuable tier held is what keeps a purchase from replacing it with a cheaper one.
 */
export function pickHeldTier(held: HeldTier[]): HeldTier | null {
  if (held.length === 0) return null;
  const sorted = [...held].sort((a, b) => compareKeys(a.variantKey, b.variantKey));
  const unranked = sorted.find((h) => !hasFixedPrice(h.product));
  if (unranked) return unranked;
  return sorted.reduce((best, h) =>
    (h.product?.amountCents ?? 0) > (best.product?.amountCents ?? 0) ? h : best
  );
}

/**
 * Ranks `target` (a membership product of the held tier's association) against `held`. Rank is
 * derived from data - the product price - with no stored ordinal: `variantLevel` is null in
 * production and only ever sorted the shop.
 */
export function tierRelation(target: RankedTier, held: HeldTier | null): TierRelation {
  if (!held) return 'none';
  if (target.variantKey === held.variantKey) return 'held';
  if (!hasFixedPrice(target) || !hasFixedPrice(held.product)) return 'unranked';
  return target.amountCents > held.product.amountCents ? 'higher' : 'lower';
}

/**
 * `tierRelation` for a viewer who may hold SEVERAL tier tags (a legacy base tag beside a named one):
 * a target among `heldKeys` is `held` whichever tier `pickHeldTier` ranks against, so buying the
 * cheaper of two held tiers answers "already held", not "not a rise".
 */
export function tierRelationOf(
  target: RankedTier,
  heldKeys: readonly (string | null)[],
  held: HeldTier | null
): TierRelation {
  if (heldKeys.includes(target.variantKey)) return 'held';
  return tierRelation(target, held);
}

/**
 * The `code` of the 400 a product create or update gets when its `memberPriceTag` names no OTHER
 * cotisation tier of the product's own association (another association's tag, a non-tier tag, the
 * product's own tier). Refused at save because such a link prices nothing: `fixedPriceFor` would
 * charge the full price, silently, to every buyer the admin meant to discount.
 */
export const MEMBER_PRICE_TAG_NOT_A_TIER = 'MEMBER_PRICE_TAG_NOT_A_TIER';

/**
 * The sibling tier a stored `memberPriceTag` names, as its `variantKey`, or `undefined` when it
 * names none of `tierKeys`. The tag is matched against each tier's tag STEM (`cotisant:<slug>` or
 * `cotisant:<slug>-<variant>`), with or without an academic-year suffix: a `dated` association's
 * tag is re-derived every academic year, so the literal string an admin saved names the tier, never
 * the tag a holder carries today.
 */
export function linkedTierKey(
  memberPriceTag: string,
  slug: string,
  tierKeys: (string | null)[]
): string | null | undefined {
  for (const key of tierKeys) {
    const stem = deriveCotisationTag(slug, 'lifetime', new Date(), key).tagName;
    if (memberPriceTag === stem) return key;
    const rest = memberPriceTag.startsWith(`${stem}-`) ? memberPriceTag.slice(stem.length + 1) : '';
    if (/^\d{4}-\d{4}$/.test(rest)) return key;
  }
  return undefined;
}

/** The pricing columns of a product with one price for everybody (no grid). */
export interface FixedPricedProduct {
  amountCents: number;
  amountCentsMember: number | null;
  memberPriceTag: string | null;
}

/**
 * The amount a fixed-price product charges one buyer. The preferential price (`amountCentsMember`)
 * applies when the buyer qualifies: holding the sibling tier `memberPriceTag` names when the admin
 * set one ("Tarif preferentiel depuis" - which is how a rise costs only the complement), else being
 * a cotisant of the association at all. Nothing is computed from tier prices: the complement IS the
 * admin's preferential price, and a tier without one is charged in full.
 */
export function fixedPriceFor(
  product: FixedPricedProduct,
  buyer: { isCotisant: boolean; holdsLinkedTier: boolean }
): { amountCents: number; preferential: boolean } {
  const qualifies = product.memberPriceTag ? buyer.holdsLinkedTier : buyer.isCotisant;
  if (qualifies && product.amountCentsMember != null) {
    return { amountCents: product.amountCentsMember, preferential: true };
  }
  return { amountCents: product.amountCents, preferential: false };
}
