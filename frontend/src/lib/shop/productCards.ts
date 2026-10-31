import type { AssociationProduct } from '$lib/associations/api';
import { tierNotOffered } from '$lib/pricing/viewerPrice';
import { m } from '$lib/paraglide/messages';

/** A key such as `balance_topup`: lowercase words joined by underscores, never written for a person. */
const TECHNICAL_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

/**
 * The name shown to people for a product. A product with no human name (empty, or a technical key
 * such as the Cercle's `balance_topup`) is shown under a localized label of its TYPE; a snake_case
 * key is never printed.
 */
export function productDisplayName(p: Pick<AssociationProduct, 'name' | 'type'>): string {
  const name = p.name?.trim() ?? '';
  if (name !== '' && !TECHNICAL_KEY.test(name)) return name;
  return p.type === 'balance_topup'
    ? m.shop_label_topup()
    : p.type === 'membership'
      ? m.shop_label_membership()
      : m.shop_label_other();
}

/**
 * The cotisation tiers this viewer may still buy, as ONE card with a row per tier: a pure
 * presentation filter over `tierNotOffered`, the server-backed decision - held, a lower tier, an
 * unranked one, or the association's cotisations being disabled each offer NO row, and nothing
 * here re-derives WHY. Ordered base-first, then by ascending level. An empty list (the highest
 * tier held, or an association selling none) means there is no membership card at all - see
 * `cotisationDisabled` for the one case that still owes a reason.
 */
export function offeredTiers(products: AssociationProduct[]): AssociationProduct[] {
  return products
    .filter((p) => p.type === 'membership' && tierNotOffered(p) === null && hasAPrice(p))
    .sort((a, b) => tierRank(a) - tierRank(b));
}

function tierRank(p: AssociationProduct): number {
  return p.variantKey === null ? -1 : (p.variantLevel ?? 0);
}

/** The products that are not membership tiers: they keep one card each. */
export function nonTierProducts(products: AssociationProduct[]): AssociationProduct[] {
  return products.filter((p) => p.type !== 'membership' && hasAPrice(p));
}

/**
 * False for a product with no price at all - no grid, no fixed amount, no free amount - such as the
 * base tier every association gets unpriced when it enables cotisations. The checkout refuses it
 * ("No amount provided", `decidePurchase`), so the shop shows no card or row whose every press
 * fails; it read "Gratuit / Cotiser" before (owner review of 1.5.1-alpha.7). Such a cotisation is
 * granted by hand in the Achats tab, never sold.
 */
export function hasAPrice(p: AssociationProduct): boolean {
  return p.priceMatrix != null || p.amountCents !== null || p.allowCustomAmount;
}

/**
 * True when this association's cotisations are disabled (`cotisationDisabled`, read off any of its
 * membership products - the server sets it the same way on every one). The membership card then
 * hides its tier rows (every one of them is refused anyway) and shows the reason instead of
 * nothing, which otherwise reads exactly like the highest tier already being held.
 */
export function cotisationDisabledForAssociation(products: AssociationProduct[]): boolean {
  return products.some((p) => p.type === 'membership' && p.cotisationDisabled === true);
}

/**
 * True when a tier cannot be ranked against the one the viewer holds (`unranked`) and the viewer
 * does hold a membership: the card then says why that tier has no row, in the words of the
 * server's `TIER_NOT_RANKABLE` refusal. A pure presentation check over `tierNotOffered`.
 */
export function hasUnrankedTier(products: AssociationProduct[]): boolean {
  return (
    products.some((p) => p.type === 'membership' && tierNotOffered(p) === 'unranked') &&
    products.some((p) => p.viewerIsCotisant === true)
  );
}
