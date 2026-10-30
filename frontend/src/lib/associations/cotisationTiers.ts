/**
 * The admin cotisation tier editor's reasoning, kept out of the component so it can be tested: the
 * order tiers are read in, and the sentence that says what a holder of one tier pays to rise to
 * another (docs/wiki/cotisations.md "The tier editor").
 *
 * Nothing here decides money. The checkout prices a rise from the stored pair
 * `memberPriceTag` + `amountCentsMember` alone; this module only words that pair for a person.
 */
import { m } from '$lib/paraglide/messages';
import { formatAmount } from '$lib/forms/fillAnswers';
import type { AssociationProduct, CotisationOptions } from './api';

/**
 * Whether the screen may offer to create a tier: only when the server SAID it derives the key from
 * the label (`tierKeyFromLabel` in `cotisation-options`). An older server strips the
 * `deriveVariantKey` flag and would create a base tier instead, so the absence of the capability -
 * or options that could not be read - offers nothing rather than guessing.
 */
export function mayCreateTier(
  options: Pick<CotisationOptions, 'tierKeyFromLabel'> | null | undefined
): boolean {
  return options?.tierKeyFromLabel === true;
}

/** The columns of a tier product the editor reads. */
export type TierLike = Pick<
  AssociationProduct,
  | 'id'
  | 'name'
  | 'amountCents'
  | 'priceMatrix'
  | 'grantedTagName'
  | 'variantKey'
  | 'allowCustomAmount'
>;

/** A tier's one price for everybody, or null when a grid prices it or no price is set. */
export function singlePriceCents(
  tier: Pick<TierLike, 'amountCents' | 'priceMatrix'>
): number | null {
  return tier.priceMatrix ? null : (tier.amountCents ?? null);
}

/**
 * A tier's rank in cents, or null when it cannot be ranked - the client twin of `rankPriceCents` in
 * social-service `tier-pricing.ts`, so the order read here is the order the checkout enforces. The
 * BASE tier (`variantKey` null) with no price and no grid ranks LOWEST, as 0; a named tier with no
 * price, a grid, or a free amount (`allowCustomAmount`) is unrankable. Both sides read the shared
 * vector `tools/tier-rank-vector.json`, so they cannot drift.
 */
export function tierRankCents(
  tier: Pick<TierLike, 'amountCents' | 'priceMatrix' | 'variantKey' | 'allowCustomAmount'>
): number | null {
  if (tier.priceMatrix || tier.allowCustomAmount) return null;
  if (tier.amountCents !== null && tier.amountCents !== undefined) return tier.amountCents;
  return tier.variantKey === null ? 0 : null;
}

/**
 * Tiers in their reading order, cheapest first - the order the checkout ranks a rise by (product
 * price). An unpriced base tier ranks lowest; a tier with no rankable price (a grid, or a named tier
 * with none set) goes last; ties fall back to the label so the order never depends on the API's.
 */
export function tiersInPriceOrder<T extends TierLike>(tiers: readonly T[]): T[] {
  return [...tiers].sort((a, b) => {
    const pa = tierRankCents(a);
    const pb = tierRankCents(b);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * A euro amount typed in an admin field, in cents; null when the field is empty or not a number.
 * Accepts a comma as decimal separator, which is what a French keyboard types.
 */
export function eurosToCents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(',', '.');
  if (text === '') return null;
  const euros = Number(text);
  return Number.isFinite(euros) ? Math.round(euros * 100) : null;
}

/** A cent amount as the euro figure an admin field shows, or empty for none. */
export function centsToEuros(cents: number | null | undefined): number | '' {
  return cents === null || cents === undefined ? '' : cents / 100;
}

/** A tier's price as a person reads it: the locale's currency format, or "not set". */
export function tierPriceLabel(cents: number | null): string {
  return cents === null ? m.asso_cotisations_tier_price_free_label() : formatAmount(cents);
}

/** The sibling a tier's preferential price is conditioned on, found by the tag it grants. */
export function riseSourceTier<T extends TierLike>(
  tiers: readonly T[],
  memberPriceTag: string | null | undefined
): T | null {
  if (!memberPriceTag) return null;
  return tiers.find((t) => t.grantedTagName === memberPriceTag) ?? null;
}

/**
 * The tiers a preferential price may be conditioned on: every OTHER tier that grants a tag (one
 * that grants none could not be matched to a buyer), in reading order.
 */
export function riseSources<T extends TierLike>(tiers: readonly T[], selfId?: string): T[] {
  return tiersInPriceOrder(tiers.filter((t) => t.id !== selfId && t.grantedTagName));
}

/**
 * The source tier a freshly switched-on preferential price starts from: the dearest tier still
 * cheaper than this one (the rise most holders make), else the first source in reading order.
 */
export function defaultRiseSource<T extends TierLike>(
  sources: readonly T[],
  fullCents: number | null
): T | null {
  if (fullCents !== null) {
    const below = sources.filter((t) => {
      const price = tierRankCents(t);
      return price !== null && price < fullCents;
    });
    if (below.length > 0) return below[below.length - 1];
  }
  return sources[0] ?? null;
}

/** What a rise costs, as the editor has it: who rises, to what, and the two prices. */
export interface RiseQuote {
  /** The tier held, or null when no preferential price is set (everybody pays in full). */
  fromName: string | null;
  /** The tier risen to - the one being edited. */
  toName: string;
  /** The tier's full price, or null when none is set. */
  fullCents: number | null;
  /** The preferential price, or null when the field is empty. */
  riseCents: number | null;
}

/**
 * The sentence the preview shows: what a holder of `fromName` pays to rise to `toName`. Without a
 * source tier, it says the opposite fact the admin must see - every holder pays the FULL price,
 * because nothing computes a complement on its own.
 */
export function riseSentence(q: RiseQuote): string {
  const full = tierPriceLabel(q.fullCents);
  if (q.fromName === null) return m.asso_cotisations_rise_preview_none({ to: q.toName, full });
  if (q.riseCents === null) {
    return m.asso_cotisations_rise_preview_full({ from: q.fromName, to: q.toName, full });
  }
  return m.asso_cotisations_rise_preview({
    from: q.fromName,
    to: q.toName,
    due: formatAmount(q.riseCents),
    full,
  });
}

/**
 * True when the preferential price gives nothing off: it is at or above the full price, so the
 * setting changes no amount anybody pays. Shown as a warning, never refused - it is still a price.
 */
export function riseGivesNoDiscount(q: RiseQuote): boolean {
  return (
    q.fromName !== null &&
    q.riseCents !== null &&
    q.fullCents !== null &&
    q.riseCents >= q.fullCents
  );
}
