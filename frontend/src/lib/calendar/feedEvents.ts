import { generateAvatarColor } from '$lib/utils/avatar';
import { toHex } from '$lib/utils/color';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/**
 * WHAT A CALENDAR FEED EVENT LOOKS LIKE ON A ROW, IN ONE PLACE.
 *
 * The agenda draws the same event twice - as a grid cell with a day panel under it on a wide
 * screen, and as a schedule list on a phone - and both need the same three answers: which day does
 * this event occupy, what colour is it, and how is its time written. Two copies of "does this
 * multi-day event cover this day" is two chances to disagree about the end of a month.
 *
 * Everything here is LOCAL-TIME by construction. An event's `startsAt` is an instant; a calendar
 * asks which square it belongs in, and that is a question about the reader's own midnight.
 */

/** A day that has at least one event, with the events already ordered by start. */
export interface EventDayGroup {
  /** Local midnight of the day, for `isToday` and for formatting. */
  date: Date;
  /** Day of the month, 1-31. */
  day: number;
  events: AssociationCalendarFeedEvent[];
}

/** Local midnight of the day an instant falls in. */
function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/**
 * Whether `event` occupies `day` - true for every day a multi-day event spans, not only its first.
 *
 * An event with no `endsAt` is a point in time and occupies exactly the day it starts on.
 */
export function eventCoversDay(event: AssociationCalendarFeedEvent, day: Date): boolean {
  const target = startOfLocalDay(day);
  const start = startOfLocalDay(new Date(event.startsAt));
  if (!event.endsAt) return target.getTime() === start.getTime();
  const end = startOfLocalDay(new Date(event.endsAt));
  return target >= start && target <= end;
}

/** Every event covering one day of `focusDate`'s month, ordered by start. */
export function eventsOnDay(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  day: number
): AssociationCalendarFeedEvent[] {
  const target = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
  return events
    .filter((event) => eventCoversDay(event, target))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/**
 * The month of `focusDate`, as one group per day THAT HAS EVENTS.
 *
 * Empty days are dropped rather than rendered blank: a schedule is a list of what is happening, and
 * a month with four events should be four rows and not thirty. A multi-day event appears in every
 * day it covers, which is what makes the list answer "what is on today" rather than "what started
 * today".
 */
export function groupMonthEventsByDay(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date
): EventDayGroup[] {
  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const groups: EventDayGroup[] = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const onThisDay = eventsOnDay(events, focusDate, day);
    if (onThisDay.length > 0) {
      groups.push({ date: new Date(year, month, day), day, events: onThisDay });
    }
  }
  return groups;
}

/** The association's colour, or a stable one derived from its id when it has not set one. */
export function eventAccentColor(event: AssociationCalendarFeedEvent): string {
  return toHex(event.associationColor ?? generateAvatarColor(event.associationId));
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso)
  );
}

/** `18:00` for an event with no end, `18:00 - 20:00` for one with. */
export function formatEventTimeRange(event: AssociationCalendarFeedEvent): string {
  const start = formatTime(event.startsAt);
  if (!event.endsAt) return start;
  return `${start} - ${formatTime(event.endsAt)}`;
}
