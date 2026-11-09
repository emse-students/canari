/**
 * THE ORGANISER'S DASHBOARD, ITS PURE HALF (WP-R5, D50, Q-R16): the week's counters, read from the
 * same `GET spaces/:id/slots` answer the dashboard's grid draws - every column of the space, the
 * days of the week shown - so the numbers and the grid can never disagree.
 */
import type { ResourceSlots } from './api';
import { formatDay, unitDay } from './grid';
import { m } from '$lib/paraglide/messages';

/**
 * The bookings of the week `week` (its local dates, in the space's zone `timeZone`) over `slots`:
 * each distinct live booking with a unit in the week, once whatever its number of units. A unit
 * belongs to the day it STARTS on (`unitDay`), as the grid places it, so the day-before part of the
 * read is never counted. The dashboard's one counter (owner, 2026-10-31: the hours and blocks
 * chips were removed).
 */
export function weekBookingCount(
  slots: readonly ResourceSlots[],
  week: readonly string[],
  timeZone: string
): number {
  const days = new Set(week);
  const bookings = new Set<string>();
  for (const resource of slots) {
    for (const unit of resource.units) {
      if (unit.state === 'booked' && days.has(unitDay(unit, timeZone))) {
        bookings.add(unit.booking.id);
      }
    }
  }
  return bookings.size;
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
