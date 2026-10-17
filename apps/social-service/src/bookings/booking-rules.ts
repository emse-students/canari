/**
 * THE RULES A BOOKING IS HELD TO, BESIDE ITS SHAPE (`slots.ts`): the booking window (D26), the two
 * per-person quotas (D17) and the participants' withdrawal delay (D5). Pure functions over a `nowMs`
 * the caller reads ONCE, so the server - never the client alone - applies them, and every case is
 * a table-driven test (`booking-rules.spec.ts`).
 *
 * Each refusal is a CODE, never a sentence: the API (WP-B3) maps it to its status and the screens
 * to a Paraglide message, so nobody branches on prose.
 */
import type { BookingQuotaPeriod } from './entities/booking-space.entity';
import type { Range } from './slots';
import { isoWeekMonday, localDate } from './zoned-time';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The space settings of the booking window (D26), all optional. */
export interface WindowSettings {
  opensAt: Date | null;
  minNoticeMinutes: number | null;
  horizonDays: number | null;
}

/** Why the booking window refuses a range. */
export type WindowRefusal = 'not-open-yet' | 'started' | 'notice' | 'beyond-horizon';

/**
 * Whether a range may be booked NOW under the space's window:
 * - `not-open-yet`: before the space's opening date;
 * - `started`: the slot has begun (a past slot is history, D15);
 * - `notice`: it starts sooner than `minNoticeMinutes` from now;
 * - `beyond-horizon`: it starts more than `horizonDays` x 24 h from now (elapsed time, so the
 *   horizon slides with the clock and does not jump at local midnight).
 */
export function checkBookingWindow(
  settings: WindowSettings,
  range: Range,
  nowMs: number
): WindowRefusal | null {
  if (settings.opensAt && nowMs < settings.opensAt.getTime()) return 'not-open-yet';
  if (range.startMs <= nowMs) return 'started';
  if (settings.minNoticeMinutes && range.startMs < nowMs + settings.minNoticeMinutes * MINUTE_MS) {
    return 'notice';
  }
  if (settings.horizonDays && range.startMs > nowMs + settings.horizonDays * DAY_MS) {
    return 'beyond-horizon';
  }
  return null;
}

/** The space settings of the two per-person ceilings (D17), none by default. */
export interface QuotaSettings {
  timeZone: string;
  maxActiveBookings: number | null;
  maxMinutesPerPeriod: number | null;
  quotaPeriod: BookingQuotaPeriod | null;
}

/** Why a quota refuses a booking. */
export type QuotaRefusal = 'active-bookings' | 'minutes-per-period';

/** The period a booking counts in: its local start DATE, or the Monday of its ISO week. */
export function quotaPeriodKey(period: BookingQuotaPeriod, startMs: number, zone: string): string {
  const date = localDate(startMs, zone);
  return period === 'day' ? date : isoWeekMonday(date);
}

/**
 * Whether one more booking of `range` keeps the person under the space's ceilings. `mine` is every
 * LIVE booking of this space in which the person counts - as holder or as a participant who has
 * not withdrawn (D17) - excluding the one being made.
 *
 * - `active-bookings`: the bookings not yet ENDED (a booking in progress still counts) plus this
 *   one exceed `maxActiveBookings`;
 * - `minutes-per-period`: the minutes of the bookings STARTING in the same local day or ISO week
 *   plus this one exceed `maxMinutesPerPeriod`.
 *
 * An organiser booking on someone's behalf is exempt (D17, D20): the caller does not call this.
 */
export function checkQuotas(
  settings: QuotaSettings,
  mine: readonly Range[],
  range: Range,
  nowMs: number
): QuotaRefusal | null {
  if (settings.maxActiveBookings !== null) {
    const active = mine.filter((b) => b.endMs > nowMs).length;
    if (active + 1 > settings.maxActiveBookings) return 'active-bookings';
  }
  if (settings.maxMinutesPerPeriod !== null && settings.quotaPeriod !== null) {
    const { quotaPeriod: period, timeZone: zone } = settings;
    const key = quotaPeriodKey(period, range.startMs, zone);
    const used = mine
      .filter((b) => quotaPeriodKey(period, b.startMs, zone) === key)
      .reduce((sum, b) => sum + (b.endMs - b.startMs), 0);
    if ((used + range.endMs - range.startMs) / MINUTE_MS > settings.maxMinutesPerPeriod) {
      return 'minutes-per-period';
    }
  }
  return null;
}

/**
 * Whether a PARTICIPANT may still withdraw (D5, decided by the user 2026-10-17): until
 * `participantWithdrawMinMinutes` before the start, 0 meaning until the start itself, so a
 * last-minute withdrawal does not leave the holder short. The HOLDER and the organiser are never
 * delayed: they may cancel at any time before the start. After the start nothing moves, for
 * anyone: the booking is history (D15).
 */
export function participantMayWithdraw(
  participantWithdrawMinMinutes: number,
  startMs: number,
  nowMs: number
): boolean {
  return nowMs < startMs - participantWithdrawMinMinutes * MINUTE_MS;
}
