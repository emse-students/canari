import type { AssociationProduct } from '$lib/associations/api';
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
 * The cotisation tiers this viewer may still buy: only what the server marks a rise (`higher`) or
 * unranked (`none`). The tier held, a lower one, and a listing that does not say (no
 * `viewerTierRelation`, an old server) offer no action - nothing is guessed from tags or prices. Ordered base-first, then by ascending level. An empty list means there is no
 * membership card at all (the highest tier is held, or the association sells none).
 */
export function offeredTiers(products: AssociationProduct[]): AssociationProduct[] {
  return products
    .filter(
      (p) =>
        p.type === 'membership' &&
        (p.viewerTierRelation === 'higher' || p.viewerTierRelation === 'none')
    )
    .sort((a, b) => tierRank(a) - tierRank(b));
}

function tierRank(p: AssociationProduct): number {
  return p.variantKey === null ? -1 : (p.variantLevel ?? 0);
}

/** The products that are not membership tiers: they keep one card each. */
export function nonTierProducts(products: AssociationProduct[]): AssociationProduct[] {
  return products.filter((p) => p.type !== 'membership');
}

/**
 * What THIS viewer pays, as the server resolved it, in cents; null when no fixed figure exists
 * (free amount, refused grid cell). `viewerDueCents` wins; a listing that does not carry it falls
 * back to the grid's cell, then to the listed price. Nothing is computed here.
 */
export function dueCents(p: AssociationProduct): number | null {
  if (typeof p.viewerDueCents === 'number') return p.viewerDueCents;
  if (p.viewerPrice?.kind === 'grid') return p.viewerPrice.amountCents;
  return p.amountCents;
}

/**
 * The full price to show struck through next to the due amount, or null when the viewer pays it
 * in full (or the product has no fixed price).
 */
export function struckCents(p: AssociationProduct): number | null {
  const due = dueCents(p);
  if (due === null || p.amountCents === null || p.viewerPrice?.kind === 'grid') return null;
  return due < p.amountCents ? p.amountCents : null;
}
