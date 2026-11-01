import { formatShortDay, formatTimeRange } from '$lib/bookings/grid';
import { addDays, localDate, localTime } from '$lib/bookings/zonedTime';
import { m } from '$lib/paraglide/messages';

/**
 * THE ONE-LINE WHEN of a booking row on the Reservations home: "Aujourd'hui · 17:00 - 18:00",
 * "Demain · ...", or the short date ("jeu. 12 nov. · 14:25 - 14:50") further away. Days are the
 * space's (D25), read at the device's `nowMs` - a heading, never a rule.
 */
export function bookingWhen(startMs: number, endMs: number, zone: string, nowMs: number): string {
  const day = localDate(startMs, zone);
  const today = localDate(nowMs, zone);
  const head =
    day === today
      ? m.bookings_week_today()
      : day === addDays(today, 1)
        ? m.bookings_upcoming_tomorrow()
        : formatShortDay(day);
  return `${head} · ${formatTimeRange(startMs, endMs, zone)}`;
}

/**
 * The wall time at which the reader's reminder fires ("16:00") in the space's zone, or `null`
 * when they have none. The row's bell chip shows it, so the chip answers "when" and not "how".
 */
export function reminderTime(startMs: number, minutes: number | null, zone: string): string | null {
  if (minutes === null) return null;
  return localTime(startMs - minutes * 60_000, zone);
}

/** The columns line of a space row: nothing for one column (D44), a count from two. */
export function resourcesLabel(count: number): string | null {
  return count > 1 ? m.bookings_row_resources({ count }) : null;
}
