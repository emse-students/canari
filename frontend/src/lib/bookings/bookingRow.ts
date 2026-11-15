import { formatShortDay, formatTimeRange } from '$lib/bookings/grid';
import { addDays, localDate, localTime } from '$lib/bookings/zonedTime';
import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';
import { intlLocale } from '$lib/utils/intlLocale';

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
 * The reminder chip of a coming booking: when the reader's reminder FIRES, in the space's zone -
 * "14:00" on the booking's own day, but "Auj. 14:00" / "Dem. 14:00" / "ven. 14:00" when it fires
 * on another day (a day-before reminder read as the start time, 2026-11-15). Null without a
 * reminder, and null once it has gone out (`sentAtMs`) or its instant has passed (`nowMs`): a past
 * time is never shown as if it were pending.
 */
export function reminderChip(
  startMs: number,
  minutes: number | null,
  zone: string,
  nowMs: number,
  sentAtMs: number | null
): string | null {
  if (minutes === null) return null;
  const fireMs = startMs - minutes * 60_000;
  if (sentAtMs !== null || fireMs <= nowMs) {
    Log.d('BOOKINGS', 'reminder chip hidden: already sent or past', {
      sent: sentAtMs !== null,
    });
    return null;
  }
  const time = localTime(fireMs, zone);
  const day = localDate(fireMs, zone);
  if (day === localDate(startMs, zone)) return time;
  const today = localDate(nowMs, zone);
  if (day === today) return m.bookings_row_reminder_today({ time });
  if (day === addDays(today, 1)) return m.bookings_row_reminder_tomorrow({ time });
  return m.bookings_row_reminder_day({ day: formatWeekday(day), time });
}

/** The short weekday of a calendar date in the reader's language: "ven.". */
function formatWeekday(date: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(y, mo - 1, d))
  );
}

/** The columns line of a space row: nothing for one column (D44), a count from two. */
export function resourcesLabel(count: number): string | null {
  return count > 1 ? m.bookings_row_resources({ count }) : null;
}
