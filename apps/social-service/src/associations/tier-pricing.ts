import { deriveCotisationTag } from './cotisation-tag.util';
import { PRODUCT_ALREADY_PURCHASED, TIER_NOT_A_RISE, TIER_NOT_RANKABLE } from './product-checkout';

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
 * - `unranked`: a tier is held, but it or the target has no rankable price (a grid, a free amount, a
 *   named tier with no price, a tag whose tier product is gone - see `rankPriceCents`), so no rank can be defended - refused rather than guessed.
 */
export type TierRelation = 'none' | 'held' | 'higher' | 'lower' | 'unranked';

/** The columns a tier is ranked on: the PRODUCT price, never what a holder happened to pay. */
export interface RankedTier {
  variantKey: string | null;
  amountCents: number | null;
  priceMatrix?: unknown;
  /** A pay-what-you-want product: its `amountCents` is not a price, so it is never ranked. */
  allowCustomAmount?: boolean | null;
}

/**
 * A tier a viewer holds: its `variantKey`, and its product when one still exists (a tag can outlive
 * its tier product, so `product` may be null).
 */
export interface HeldTier {
  variantKey: string | null;
  product: RankedTier | null;
}

/**
 * THE rank of a tier, in cents, or null when none can be defended - the one place a tier's standing
 * is decided (the client's `tierRankCents` mirrors it). A tier with one price ranks by it. The BASE
 * tier (`variantKey` null) that carries no price at all - no grid, no amount, which is how every
 * association gets it when it enables cotisations - ranks LOWEST of the association, as 0: it is the
 * entry level, so every priced tier is a rise over it and it is never a rise over anything. A named
 * tier with no price, a grid, a free amount (`allowCustomAmount`) or a missing product stays
 * unrankable.
 */
export function rankPriceCents(t: RankedTier | null): number | null {
  if (t === null || t.priceMatrix != null || t.allowCustomAmount) return null;
  if (t.amountCents !== null) return t.amountCents;
  return t.variantKey === null ? 0 : null;
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
  const unranked = sorted.find((h) => rankPriceCents(h.product) === null);
  if (unranked) return unranked;
  return sorted.reduce((best, h) =>
    (rankPriceCents(h.product) ?? 0) > (rankPriceCents(best.product) ?? 0) ? h : best
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
  const targetPrice = rankPriceCents(target);
  const heldPrice = rankPriceCents(held.product);
  if (targetPrice === null || heldPrice === null) return 'unranked';
  return targetPrice > heldPrice ? 'higher' : 'lower';
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

/** The typed 409 body a refused tier purchase answers with. */
export interface TierRefusal {
  code: string;
  message: string;
}

const TIER_REFUSALS: Record<TierRelation, TierRefusal | null> = {
  none: null,
  higher: null,
  held: { code: PRODUCT_ALREADY_PURCHASED, message: 'You already hold this membership' },
  lower: {
    code: TIER_NOT_A_RISE,
    message: 'You already hold a membership tier worth at least this one',
  },
  unranked: {
    code: TIER_NOT_RANKABLE,
    message: 'Your current membership tier cannot be compared with this one',
  },
};

/**
 * The typed 409 a payment for a cotisation tier is refused with BEFORE any payment request is
 * opened, or null when it is sold (`none`, `higher`). The boutique checkout's mapping, and the base
 * of a paid form's (`formTierRefusal`): `held` -> `PRODUCT_ALREADY_PURCHASED`, `lower` ->
 * `TIER_NOT_A_RISE`, `unranked` -> `TIER_NOT_RANKABLE`.
 */
export function tierRefusal(relation: TierRelation): TierRefusal | null {
  return TIER_REFUSALS[relation];
}

/**
 * The `code` of the 409 a paid answer gets when its form grants a cotisation tier that no longer
 * EXISTS: the form's `cotisationVariantKey` names no tier product of the association, which happens
 * only when that product was DELETED - a tier merely taken off sale (`isActive` false) is still in
 * the catalogue (`listCotisationTiers`) and is ranked as usual. The grant could never succeed, for
 * ANY submitter, so no money is taken. Not `TIER_NOT_RANKABLE`, whose sentence speaks of the
 * submitter's current membership - meaningless to someone who holds none. (The code says "not
 * sold" for history; what it means is "gone".)
 */
export const FORM_TIER_NOT_SOLD = 'FORM_TIER_NOT_SOLD';

/**
 * The `code` of the 409 a paid answer gets when the submitter already holds the very tier its form
 * grants. The checkout's `PRODUCT_ALREADY_PURCHASED` would be worded "you already bought this
 * product", which is not what a form is.
 */
export const FORM_TIER_ALREADY_HELD = 'FORM_TIER_ALREADY_HELD';

/**
 * Where a paid form's tier stands for one submitter: a `TierRelation`, or `not-sold` when the tier's
 * product no longer exists (`FORM_TIER_NOT_SOLD`).
 */
export type FormTierRank = TierRelation | 'not-sold';

/**
 * The typed 409 a paid answer to a form that grants a cotisation tier is refused with, or null when
 * it is taken: the checkout's rule (`tierRefusal`) with the two codes a form words its own way -
 * `not-sold` -> `FORM_TIER_NOT_SOLD`, `held` -> `FORM_TIER_ALREADY_HELD`.
 */
export function formTierRefusal(rank: FormTierRank): TierRefusal | null {
  if (rank === 'not-sold') {
    return {
      code: FORM_TIER_NOT_SOLD,
      message: 'This form grants a membership tier that no longer exists',
    };
  }
  if (rank === 'held') {
    return {
      code: FORM_TIER_ALREADY_HELD,
      message: 'You already hold the membership this form grants',
    };
  }
  return tierRefusal(rank);
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

/**
 * A cotisation tag an association issued for a tier it no longer has: what a holder keeps when the
 * tier's product is deleted (docs/wiki/cotisations.md "A tier deleted while people still hold it").
 * `variantKey` is the key read back from the tag name (`null` for the base tier's stem), and never
 * equals the key of a tier that exists.
 */
export interface OrphanTierTag {
  tagName: string;
  variantKey: string | null;
}

const ACADEMIC_YEAR_TAIL = /-\d{4}-\d{4}$/;

/**
 * Which of `tagNames` - tags ISSUED BY the association whose slug is `slug` - are cotisation tags of
 * a tier that is not among `tierKeys`. A tag is in the association's cotisation namespace when it is
 * `cotisant:<slug>` or starts with `cotisant:<slug>-`; it belongs to an existing tier when
 * `linkedTierKey` matches it (with or without an academic-year suffix, so a `dated` tag of a past or
 * present year and a `lifetime` tag of the same tier both do). Everything else in the namespace is
 * an orphan. The caller passes only rows the association itself issued, which is what keeps another
 * association whose slug happens to extend this one (`bde` and `bde-ski`) out of it.
 */
export function orphanTierTags(
  tagNames: readonly string[],
  slug: string,
  tierKeys: readonly (string | null)[]
): OrphanTierTag[] {
  const root = `cotisant:${slug}`;
  const orphans: OrphanTierTag[] = [];
  for (const tagName of new Set(tagNames)) {
    if (tagName !== root && !tagName.startsWith(`${root}-`)) continue;
    if (linkedTierKey(tagName, slug, [...tierKeys]) !== undefined) continue;
    const rest = tagName.slice(root.length + 1);
    const variant = /^\d{4}-\d{4}$/.test(rest) ? '' : rest.replace(ACADEMIC_YEAR_TAIL, '');
    orphans.push({ tagName, variantKey: variant || null });
  }
  return orphans.sort((a, b) => (a.tagName < b.tagName ? -1 : a.tagName > b.tagName ? 1 : 0));
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

/**
 * What a settlement decides for a paid tier, from what the checkout OPENING froze (migration 112)
 * and which tiers the buyer holds NOW - never from a price, which an admin can edit in between:
 *
 * - `held`: the target tier itself is held now (obtained since the opening) - not granted;
 * - `nothing-held`: no tier is held, and none was at the opening - granted, the XOR replaces nothing;
 * - `frozen-gone`: the opening ranked against a tier (`heldTierProductId` set) and the buyer holds
 *   none now (it expired or was revoked since) - not granted: the price paid was the rise over a tier
 *   the buyer no longer has;
 * - `as-opened`: every tier held now is the one the opening ranked against - granted, which is
 *   exactly what the opening decided;
 * - `held-changed`: a tier the opening did not rank against is held (obtained since, or held where
 *   the opening saw none, or a second tier beside the frozen one) - not granted, so the XOR cannot
 *   replace a tier nobody ranked this purchase against.
 */
export type SettlementVerdict =
  | 'held'
  | 'nothing-held'
  | 'frozen-gone'
  | 'as-opened'
  | 'held-changed';

/**
 * The settlement's decision (`SettlementVerdict`). `frozenKeys` is the CURRENT `variantKey` of the
 * tier frozen at the opening - one entry, or none when nothing was held then (or its product is
 * gone) - read by product id, so a retag in between still matches. `frozeATier` is whether the
 * opening froze a tier at all (`heldTierProductId` set), which stays true when that product is gone.
 */
export function settlementVerdict(
  targetKey: string | null,
  heldKeys: readonly (string | null)[],
  frozenKeys: readonly (string | null)[],
  frozeATier: boolean
): SettlementVerdict {
  if (heldKeys.includes(targetKey)) return 'held';
  if (heldKeys.length === 0) return frozeATier ? 'frozen-gone' : 'nothing-held';
  if (heldKeys.every((k) => frozenKeys.includes(k))) return 'as-opened';
  return 'held-changed';
}

/** True when a settlement verdict grants the tier paid for. */
export function settlementGrants(verdict: SettlementVerdict): boolean {
  return verdict === 'nothing-held' || verdict === 'as-opened';
}
