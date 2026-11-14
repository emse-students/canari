import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { socialRefusal } from '$lib/associations/api';

/**
 * The fee schedule a payout estimate applies, from the platform's Lydia contract terms entered by a
 * global admin (`GET /api/payments/lydia-fee-schedule`, docs/wiki/lydia-contract-flux.md): the fee of
 * a payment Canari issues, HT as the contract states it, and the VAT that makes it what is really
 * deducted. No value lives in this file: the contract is confidential and the repository public.
 */
export interface LydiaFeeSchedule {
  /** The percentage, HT, in basis points (1 % = 100). */
  percentBps: number;
  /** The fixed part, HT, in cents. */
  fixedCents: number;
  /** The VAT rate, in basis points. */
  vatBps: number;
}

/**
 * The schedule, or `null` when an admin has not entered it - the estimate then says "not
 * configured", never a guessed figure. A failed read throws.
 */
export async function fetchLydiaFeeSchedule(): Promise<LydiaFeeSchedule | null> {
  const res = await apiFetch(`${coreUrl()}/api/payments/lydia-fee-schedule`);
  if (!res.ok) throw await socialRefusal(res);
  const data = (await res.json()) as { schedule: LydiaFeeSchedule | null };
  if (!data.schedule) Log.w('[Payments] the fee schedule is NOT CONFIGURED: no payout estimate');
  return data.schedule;
}

/**
 * The fee really deducted from a payment of `grossCents`: (fixed + percent) HT, times (1 + VAT),
 * rounded once to the cent.
 */
export function computeLydiaFeeCents(grossCents: number, schedule: LydiaFeeSchedule): number {
  if (grossCents <= 0) return 0;
  const htTimes1e4 = schedule.fixedCents * 10_000 + grossCents * schedule.percentBps;
  return Math.round((htTimes1e4 * (10_000 + schedule.vatBps)) / 100_000_000);
}

/** Gross amount minus the fee really deducted (floored at 0): what the association receives. */
export function computeLydiaNetPayoutCents(grossCents: number, schedule: LydiaFeeSchedule): number {
  if (grossCents <= 0) return 0;
  return Math.max(0, grossCents - computeLydiaFeeCents(grossCents, schedule));
}

/** Converts a euro form field to integer cents, or null when empty/invalid. */
export function eurosInputToCents(euros: number | '' | null | undefined): number | null {
  if (euros === '' || euros == null) return null;
  const value = Number(euros);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
