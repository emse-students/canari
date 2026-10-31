/**
 * THE BOOKING WINDOW OF A SPACE (D26), ONE RULE IN TWO PLACES.
 *
 * This file is copied byte for byte between the social service
 * (`apps/social-service/src/bookings/booking-window.ts`) and the screen
 * (`frontend/src/lib/bookings/bookingWindow.ts`), declared in
 * `.github/scripts/lib/declared-duplicates.mjs`, and both copies answer the cases of
 * `libs/contracts/booking-window.cases.json`. There is no shared TS package between the two
 * runtimes, so the copy is the sharing and the gate is what keeps it one rule.
 *
 * THE CLOCK IS THE SERVER'S. The server reads `nowMs` once per request and its answer is the
 * booking's fate. The screen calls the same function with the DEVICE's clock to decide what it
 * OFFERS: a unit whose start is refused is not offered, and it is redrawn when that changes. Should
 * the server refuse a request the screen offered, the server's answer counts.
 *
 * Refusals, in this order:
 * - `not-open-yet`: before the space's opening instant;
 * - `started`: the range has begun (a past range is history, D15);
 * - `notice`: it starts sooner than `minNoticeMinutes` from now;
 * - `beyond-horizon`: it starts more than `horizonDays` x 24 h from now (elapsed time, so the
 *   horizon slides with the clock and does not jump at local midnight).
 * Only the START of a range is judged: a booking of several steps is accepted or refused whole, so
 * a booking starting inside the horizon may run up to `maxSteps` x the step past it.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Why the booking window refuses a range. */
export type WindowRefusal = 'not-open-yet' | 'started' | 'notice' | 'beyond-horizon';

/** The space settings of the booking window, all optional; the opening as epoch milliseconds. */
export interface BookingWindow {
  opensAtMs: number | null;
  minNoticeMinutes: number | null;
  horizonDays: number | null;
}

/** Why a range starting at `startMs` may not be booked at `nowMs`, or null when it may. */
export function bookingWindowRefusal(
  window: BookingWindow,
  startMs: number,
  nowMs: number
): WindowRefusal | null {
  if (window.opensAtMs !== null && nowMs < window.opensAtMs) return 'not-open-yet';
  if (startMs <= nowMs) return 'started';
  if (window.minNoticeMinutes && startMs < nowMs + window.minNoticeMinutes * MINUTE_MS) {
    return 'notice';
  }
  if (window.horizonDays && startMs > nowMs + window.horizonDays * DAY_MS) return 'beyond-horizon';
  return null;
}
