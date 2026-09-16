import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { associationAccentHex } from '$lib/associations/accent';
import { getLocale } from '$lib/paraglide/runtime';

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

/**
 * WHEN A CALENDAR DAY BEGINS, AND IT IS NOT MIDNIGHT.
 *
 * A party announced 23:00-02:00 is ONE evening to everybody who goes to it, and midnight splits it
 * across two squares - so the grid showed it twice, and the second square claimed an event on a
 * morning when nothing happens. Five in the morning is the hour campus life is actually over, and
 * it is early enough that nothing legitimately scheduled starts before it.
 *
 * This is the ONE place the boundary is stated. It was a local constant in `MonthCalendarGridRich`
 * as well until 2026-09-16 - a second copy of "which day does this event occupy", which is exactly
 * what this module's own header warns against.
 */
export const DAY_STARTS_AT_HOUR = 5;

/**
 * The calendar day an INSTANT belongs to, as local midnight of that day.
 *
 * The return value stays midnight rather than 05:00 on purpose: it is the day's IDENTITY, used for
 * `isToday` and for formatting, and every caller already reads it that way. Only the ASSIGNMENT
 * moves - 02:00 on the 5th answers with the 4th.
 */
export function calendarDayOf(value: Date): Date {
  const shifted = new Date(value.getTime());
  shifted.setHours(shifted.getHours() - DAY_STARTS_AT_HOUR);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

/**
 * A SQUARE ON THE GRID, normalised - local midnight, and never shifted.
 *
 * THE TWO ARGUMENTS OF `eventCoversDay` ARE NOT THE SAME KIND OF THING, and reading them with one
 * function is how this broke: an event's `startsAt` is an INSTANT that has to be assigned to a day,
 * while `day` is ALREADY a day's identity. Shifting the identity too would have answered the 4th
 * for the square labelled 5, moving every event back a day - the 05:00 rule applied twice, once
 * where it belongs and once where it means nothing.
 */
function squareOf(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

/**
 * The square `day` of `focusDate`'s month, as a Date - or null when no square is selected.
 *
 * Both agenda surfaces hold a `focusDate` and a `selectedDay` number, and both need to turn that
 * pair back into a date to seed a form. Written once here rather than twice as a component-local
 * helper, which is how the pair already drifted apart elsewhere in these two files.
 */
export function daySquareDate(focusDate: Date, day: number | null): Date | null {
  return day === null ? null : new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
}

/**
 * Whether `event` occupies `day` - true for every day a multi-day event spans, not only its first.
 *
 * An event with no `endsAt` is a point in time and occupies exactly the day it starts on.
 */
export function eventCoversDay(event: AssociationCalendarFeedEvent, day: Date): boolean {
  const target = squareOf(day);
  const start = calendarDayOf(new Date(event.startsAt));
  if (!event.endsAt) return target.getTime() === start.getTime();
  const end = calendarDayOf(new Date(event.endsAt));
  return target >= start && target <= end;
}

/**
 * THE HOUR THAT SPLITS A DAY IN TWO, for a cell showing a single event.
 *
 * Half a cell says "morning" or "afternoon" at a glance, across a whole month, without a single
 * digit of type - and the month sheet is read at arm's length, where the times are not legible
 * anyway. 13:00 rather than 12:00 because a midday event reads as the morning's end here.
 *
 * It sits beside {@link DAY_STARTS_AT_HOUR} because the two are the same kind of fact: the hours at
 * which this app's calendar day begins and folds. It lived in `calendarExport` until 2026-09-16,
 * where {@link dayOccupancy} - the only reader that matters - could not reach it without importing
 * the PDF module.
 */
export const HALF_DAY_PIVOT_HOUR = 13;

/** Which part of ONE day an event actually fills. */
export type DayOccupancy = 'morning' | 'afternoon' | 'full';

/**
 * How much of `day` this event occupies - the question a half-filled cell answers.
 *
 * A START HOUR IS ONLY ABOUT THE DAY IT FALLS ON. Reading `startsAt` on every square a multi-day
 * event covers is how a WEI running Friday 18:00 to Sunday painted the bottom half of Saturday and
 * Sunday too: on those squares the event fills the day and its start hour says nothing about them.
 *
 * So the rule is stated once, from the day's point of view: a cell may only halve when the event
 * leaves half the day genuinely free.
 *
 * - it began earlier AND ends later - the day is full;
 * - it began earlier and ends here - it held the day from 05:00, so it is a morning only if it ends
 *   before {@link HALF_DAY_PIVOT_HOUR}, and otherwise fills;
 * - it begins here and ends later - it holds the day to 05:00 tomorrow, so it is an afternoon only
 *   if it starts at or after the pivot, and otherwise fills;
 * - it is contained in the day - the half its start hour names, which is the original rule.
 *
 * The hours are safe to compare against the pivot without re-shifting: an instant assigned to `day`
 * by {@link calendarDayOf} necessarily reads between 05:00 and 23:59 local.
 */
export function dayOccupancy(event: AssociationCalendarFeedEvent, day: Date): DayOccupancy {
  const target = squareOf(day);
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : null;
  const startsEarlier = calendarDayOf(start) < target;
  const endsLater = end !== null && calendarDayOf(end) > target;
  if (startsEarlier && endsLater) return 'full';
  if (startsEarlier && end !== null) {
    return end.getHours() < HALF_DAY_PIVOT_HOUR ? 'morning' : 'full';
  }
  if (endsLater) return start.getHours() >= HALF_DAY_PIVOT_HOUR ? 'afternoon' : 'full';
  return start.getHours() < HALF_DAY_PIVOT_HOUR ? 'morning' : 'afternoon';
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
 * The cards for one day - break entries excluded, since those draw as a full-day background band.
 *
 * THIS AND {@link breaksOnDay} EXIST TO DELETE TWO COPIES OF THEMSELVES. `MonthCalendarGridRich`
 * and `calendarExport` each carried a private `entriesOnDay` splitting a month into squares at
 * MIDNIGHT, and neither was touched when the 05:00 boundary landed on 2026-09-16 - so the evening
 * the change was written for went on being drawn twice by the two surfaces a user actually looks
 * at, while the day panel and the schedule list had it right. One implementation cannot do that.
 */
export function eventCardsOnDay(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  day: number
): AssociationCalendarFeedEvent[] {
  return eventsOnDay(events, focusDate, day).filter((event) => event.kind !== 'break');
}

/** The break entries (no-course / vacation) covering one day, drawn behind the cards. */
export function breaksOnDay(
  events: AssociationCalendarFeedEvent[],
  focusDate: Date,
  day: number
): AssociationCalendarFeedEvent[] {
  return eventsOnDay(events, focusDate, day).filter((event) => event.kind === 'break');
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

/** One association shown on an event - its owner, or one of its co-owners. */
export interface EventOwnerIdentity {
  /**
   * THE IDENTITY, AND THE ONLY THING THIS LIST MAY BE KEYED ON. A name is a label two associations
   * may share and a slug is a URL; keying the owner+co-owner list on either turned a repeated
   * label into `each_key_duplicate`, which does not paint a logo wrong - it throws, and the page
   * that was rendering it dies (prod, 2026-09-14).
   */
  associationId: string;
  name: string;
  slug: string;
  /** Hex colour set on the association, or null → a stable one is derived from the id. */
  color: string | null;
  logoUrl: string | null;
}

/**
 * Every association shown on an event: the OWNER first, then each co-owner, in display order.
 *
 * The owner is the event's own, never the page's. A per-association agenda lists the events that
 * association co-owns as well as the ones it owns, so "the association whose page this is" and
 * "the association that owns this event" are two different facts and only the row carries the
 * second one.
 */
export function eventOwners(event: AssociationCalendarFeedEvent): EventOwnerIdentity[] {
  return [
    {
      associationId: event.associationId,
      name: event.associationName,
      slug: event.associationSlug,
      color: event.associationColor,
      logoUrl: event.associationLogoUrl,
    },
    ...(event.coOwners ?? []).map((co) => ({
      associationId: co.associationId,
      name: co.name,
      slug: co.slug,
      color: co.color,
      logoUrl: co.logoUrl,
    })),
  ];
}

/**
 * Who a row says the event belongs to: EVERY association on it, owner first, joined for display.
 *
 * An event may be run by several associations at once and a row that names one of them is telling
 * half the truth - the grid paints a band per owner, so a list row that named only the first
 * disagreed with the cell right above it.
 *
 * `ownAssociationId` is the association whose OWN agenda this is, when there is one. The only thing
 * it suppresses is pure repetition: an event that association owns ALONE, on its own page, where
 * the name is already the page title. A co-owned event still names everybody, including the page
 * itself - that an event is shared is exactly what the row has to say.
 */
export function eventOwnersLabel(
  event: AssociationCalendarFeedEvent,
  ownAssociationId?: string | null
): string {
  const owners = eventOwners(event);
  if (owners.length === 1 && owners[0].associationId === ownAssociationId) return '';
  return owners.map((owner) => owner.name).join(' + ');
}

/**
 * The association's colour, or a stable one derived from its id when it has not set one.
 *
 * The calendar's named entry point, kept because two components and a test call it - but the
 * derivation is `associations/accent.ts`, the only one, rather than a fourth copy of the same
 * expression.
 */
export function eventAccentColor(event: AssociationCalendarFeedEvent): string {
  return associationAccentHex({ id: event.associationId, color: event.associationColor });
}

/**
 * The locale every calendar surface formats in.
 *
 * `getLocale()` answers `'fr'`/`'en'`, which `Intl` accepts but resolves to `en-GB`-ish defaults for
 * the second; the two region tags are named here so a date reads the same everywhere it is drawn.
 * `formatTime` hardcoded `'fr-FR'` until 2026-09-16 while the copy in the admin agenda did this,
 * so an English user read one surface in their locale and the next in French.
 */
function calendarLocale(): string {
  return getLocale() === 'en' ? 'en-US' : 'fr-FR';
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(calendarLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** `18:00` for an event with no end, `18:00 - 20:00` for one with. */
export function formatEventTimeRange(event: AssociationCalendarFeedEvent): string {
  const start = formatTime(event.startsAt);
  if (!event.endsAt) return start;
  return `${start} - ${formatTime(event.endsAt)}`;
}

/**
 * The same range with the DAY in front - "Ven 18 sept., 18:00 - 17:00".
 *
 * Used where an event is read outside a month grid and the square no longer says which day it is:
 * an association's event list and the admin agenda. Both wrote this out themselves, identically,
 * and neither could gain a fix the other did not.
 *
 * Only the START carries the date. An end time alone is the shorter, more readable thing when the
 * two are the same day, which they are for almost every event; a multi-day event is read from the
 * grid or the detail modal, where its span is drawn rather than spelt.
 */
export function formatEventDateTimeRange(event: {
  startsAt: string;
  endsAt?: string | null;
}): string {
  const locale = calendarLocale();
  const withDay = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const start = withDay.format(new Date(event.startsAt));
  if (!event.endsAt) return start;
  const end = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(event.endsAt)
  );
  return `${start} - ${end}`;
}
