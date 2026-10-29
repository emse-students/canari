/**
 * THE ORGANISER'S DASHBOARD, ITS PURE HALF (WP-R5, D50, Q-R16): the week's counters, read from the
 * same `GET spaces/:id/slots` answer the dashboard's grid draws - every column of the space, the
 * days of the week shown - so the numbers and the grid can never disagree.
 */
import type { ResourceSlots } from './api';
import { formatDay, intlLocale, unitDay } from './grid';
import { m } from '$lib/paraglide/messages';

/** What the counters line says about one week of a space, every column together. */
export interface WeekCounters {
  /** Distinct live bookings with a unit in the week. */
  bookings: number;
  /** Minutes of the week's units a booking took. */
  bookedMinutes: number;
  /**
   * Minutes of every unit offered in the week, taken or not (free, booked, blocked). Fixed slots
   * that overlap each count whole: this is what was offered, not wall-clock time.
   */
  offeredMinutes: number;
  /** Distinct blocks with a unit in the week. */
  blocks: number;
}

/**
 * The counters of the week `week` (its local dates, in the space's zone `timeZone`) over `slots`.
 * A unit belongs to the day it STARTS on (`unitDay`), as the grid places it, so the day-before
 * part of the read is never counted.
 */
export function weekCounters(
  slots: readonly ResourceSlots[],
  week: readonly string[],
  timeZone: string
): WeekCounters {
  const days = new Set(week);
  const bookings = new Set<string>();
  const blocks = new Set<string>();
  let bookedMinutes = 0;
  let offeredMinutes = 0;
  for (const resource of slots) {
    for (const unit of resource.units) {
      if (!days.has(unitDay(unit, timeZone))) continue;
      const minutes = (unit.endMs - unit.startMs) / 60_000;
      offeredMinutes += minutes;
      if (unit.state === 'booked') {
        bookings.add(unit.booking.id);
        bookedMinutes += minutes;
      } else if (unit.state === 'blocked' && unit.blockId) {
        blocks.add(unit.blockId);
      }
    }
  }
  return { bookings: bookings.size, bookedMinutes, offeredMinutes, blocks: blocks.size };
}

/** Minutes as hours for the counters line, in the reader's language: "21", "1,5" / "1.5". */
export function hoursOf(minutes: number): string {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(minutes / 60);
}

/** The local date after `date` (YYYY-MM-DD), calendar arithmetic only. */
function nextDate(date: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

/** One day of the "coming" list: its heading and its bookings, in the order they were given. */
export interface UpcomingDay<T> {
  date: string;
  label: string;
  items: T[];
}

/**
 * The "coming" list grouped by the day each booking STARTS on in the space's zone (D50's mockup:
 * "Aujourd'hui", "Demain", then the date), in the order the server gave them (by start). Today and
 * tomorrow are the space's, read at the device's `nowMs` - a heading, never a rule.
 */
export function upcomingDays<T extends { startsAt: string }>(
  items: readonly T[],
  timeZone: string,
  nowMs: number
): UpcomingDay<T>[] {
  const today = unitDay({ startMs: nowMs }, timeZone);
  const tomorrow = nextDate(today);
  const days: UpcomingDay<T>[] = [];
  for (const item of items) {
    const date = unitDay({ startMs: Date.parse(item.startsAt) }, timeZone);
    let day = days.at(-1);
    if (!day || day.date !== date) {
      // A booking under way since yesterday still reads under today: it is what is on now.
      const shown = date < today ? today : date;
      if (day && day.date === shown) {
        day.items.push(item);
        continue;
      }
      const label =
        shown === today
          ? m.bookings_week_today()
          : shown === tomorrow
            ? m.bookings_upcoming_tomorrow()
            : formatDay(shown);
      day = { date: shown, label, items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}
