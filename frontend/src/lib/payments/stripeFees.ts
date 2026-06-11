/** Fixed Stripe card processing fee per successful charge (EUR). */
export const STRIPE_CARD_FEE_FIXED_CENTS = 25;

/** Variable Stripe card fee in basis points (1.5 % = 150 bps). */
export const STRIPE_CARD_FEE_PERCENT_BPS = 150;

/**
 * Estimates Stripe card processing fees for a gross charge amount.
 * Model: 0,25 € + 1,5 % (European cards, indicative).
 */
export function computeStripeCardFeeCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  const variable = Math.round((grossCents * STRIPE_CARD_FEE_PERCENT_BPS) / 10_000);
  return STRIPE_CARD_FEE_FIXED_CENTS + variable;
}

/** Gross amount minus estimated Stripe card fees (floored at 0). */
export function computeAssociationNetPayoutCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  return Math.max(0, grossCents - computeStripeCardFeeCents(grossCents));
}

/** Converts a euro form field to integer cents, or null when empty/invalid. */
export function eurosInputToCents(euros: number | '' | null | undefined): number | null {
  if (euros === '' || euros == null) return null;
  const value = Number(euros);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
