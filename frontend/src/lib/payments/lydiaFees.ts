/** Fixed Lydia processing fee per successful payment (EUR cents). */
export const LYDIA_FEE_FIXED_CENTS = 10;

/** Variable Lydia fee in basis points (1 % = 100 bps). */
export const LYDIA_FEE_PERCENT_BPS = 100;

/**
 * Estimates Lydia processing fees for a gross payment amount.
 * Model: 0,10 € + 1 %, confirmed by Lydia 2026-09-18 (WP-LYDIA-1).
 */
export function computeLydiaFeeCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  const variable = Math.round((grossCents * LYDIA_FEE_PERCENT_BPS) / 10_000);
  return LYDIA_FEE_FIXED_CENTS + variable;
}

/** Gross amount minus estimated Lydia fees (floored at 0). */
export function computeLydiaNetPayoutCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  return Math.max(0, grossCents - computeLydiaFeeCents(grossCents));
}

/** Converts a euro form field to integer cents, or null when empty/invalid. */
export function eurosInputToCents(euros: number | '' | null | undefined): number | null {
  if (euros === '' || euros == null) return null;
  const value = Number(euros);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
