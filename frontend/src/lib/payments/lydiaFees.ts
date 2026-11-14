import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { socialRefusal } from '$lib/associations/api';
import { SharedCache } from '$lib/utils/sharedCache';
import { refusalCode } from '$lib/utils/apiRefusal';

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

/** The 403 of a reader who edits no price (core-service `LYDIA_FEES_NOT_A_PRICE_EDITOR`). */
export const LYDIA_FEES_NOT_A_PRICE_EDITOR = 'LYDIA_FEES_NOT_A_PRICE_EDITOR';

/** What the server answered: the schedule, `null` (not configured), or a refusal to this reader. */
export type LydiaFeeScheduleAnswer = LydiaFeeSchedule | null | 'not-a-price-editor';

/**
 * ONE answer per reader, held for the session's window and shared by every estimate mounted: a
 * price screen mounts one per price, and each asked again - and logged "not configured" again.
 * `{ value }` because the cache keeps an answer, and `null` is one. A transport failure is never
 * held (`SharedCache`); the admin's save drops it ({@link forgetLydiaFeeSchedule}).
 */
const feeSchedule = new SharedCache<{ value: LydiaFeeScheduleAnswer }>(10 * 60_000, {
  perReader: true,
});

/**
 * The schedule, `null` when an admin has not entered it - the estimate then says "not
 * configured", never a guessed figure - or `not-a-price-editor` for a reader the server refuses it
 * to. Each is an ANSWER, logged once when it is fetched; a failed read throws.
 */
export async function fetchLydiaFeeSchedule(): Promise<LydiaFeeScheduleAnswer> {
  const held = await feeSchedule.load('me', async () => {
    const res = await apiFetch(`${coreUrl()}/api/payments/lydia-fee-schedule`);
    if (!res.ok) {
      const refusal = await socialRefusal(res);
      if (res.status === 403 && refusalCode(refusal) === LYDIA_FEES_NOT_A_PRICE_EDITOR) {
        // A screen offered a price editor to someone who edits no price: the screen is wrong.
        Log.w('[Payments] the fee schedule was refused: this reader edits no price');
        return { value: 'not-a-price-editor' as const };
      }
      throw refusal;
    }
    const data = (await res.json()) as { schedule: LydiaFeeSchedule | null };
    if (!data.schedule) Log.w('[Payments] the fee schedule is NOT CONFIGURED: no payout estimate');
    return { value: data.schedule };
  });
  return held.value;
}

/** Drops the held schedule: called when an admin saves the contract terms. */
export function forgetLydiaFeeSchedule(): void {
  feeSchedule.invalidate();
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
