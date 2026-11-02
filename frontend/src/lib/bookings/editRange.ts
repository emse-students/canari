/**
 * WHAT AN EDIT OF A BOOKING MAY CHOOSE (owner, 2026-11-02, "Modifier la reservation"): a start on
 * the booking's OWN day and column, then how far it goes - the same "Jusqu'a" stepper a booking
 * has. The booking's own units read as FREE: its range is what the edit replaces, so it may shrink
 * into it, slide over it or keep it. Everything else is the grid's own rule (`freeRunFrom`,
 * `isOfferedStart`, `bookingUnitLimit`), so the sheet cannot name a range a booking would not be
 * offered; the server still judges every request (`BOOKING_EDIT_*`, `refusals.ts`).
 */
import type { BookerSpace, BookingView, SlotUnit } from './api';
import { bookingOthers } from './others';
import { bookingUnitLimit, freeRunFrom, isOfferedStart } from './grid';
import { localDate } from './zonedTime';
import { Log } from '$lib/utils/Log';

/** The booking an edit starts from: its id and its range. */
export interface EditedBooking {
  id: string;
  startsAt: string;
  endsAt: string;
}

/** What the edit sheet offers: the starts, the run each one opens, and what it opens on. */
export interface EditChoices {
  /** The free starts of the booking's day, the booking's own start always among them. */
  starts: SlotUnit[];
  /** The units a range from `start` may cover, the booking's own read as free. */
  runOf: (start: SlotUnit) => SlotUnit[];
  /** The booking's own start in `starts`, and how many units of its run it covers. */
  startIndex: number;
  count: number;
}

/** One column's units as an edit of `bookingId` reads them: that booking's units are free. */
export function unitsFreedFor(units: readonly SlotUnit[], bookingId: string): SlotUnit[] {
  return units.map((u) =>
    u.state === 'booked' && u.booking.id === bookingId
      ? { date: u.date, startMs: u.startMs, endMs: u.endMs, state: 'free' as const }
      : u
  );
}

/**
 * The choices of an edit of `booking`, from its column's `units` as the week read holds them - or
 * null when that read does not hold the booking's own start (the week moved, the rules changed):
 * the edit is then not offered, and the line says why.
 *
 * A start is offered as a booking's would be (`isOfferedStart`), on the booking's local day; its
 * CURRENT start is offered whatever the window says now, since keeping the time while changing the
 * people is not a new start (the server judges the window only when the range changes).
 */
export function editChoices(
  units: readonly SlotUnit[],
  booking: EditedBooking,
  space: Pick<
    BookerSpace,
    'timeZone' | 'slotMode' | 'maxSteps' | 'opensAt' | 'minNoticeMinutes' | 'horizonDays'
  >,
  nowMs: number,
  lastRefusedStart: number | null
): EditChoices | null {
  const startMs = Date.parse(booking.startsAt);
  const endMs = Date.parse(booking.endsAt);
  const day = localDate(startMs, space.timeZone);
  const freed = unitsFreedFor(units, booking.id);
  const starts = freed.filter(
    (u) =>
      u.state === 'free' &&
      localDate(u.startMs, space.timeZone) === day &&
      (u.startMs === startMs || isOfferedStart(space, u, nowMs, lastRefusedStart, false))
  );
  // A slot list may hold two slots starting at the same instant: the booking's is the one it ends.
  const startIndex = starts.findIndex(
    (u) => u.startMs === startMs && (space.slotMode !== 'slots' || u.endMs === endMs)
  );
  if (startIndex < 0) {
    Log.i(
      'BOOKINGS',
      `edit not offered: the week read does not hold booking=${booking.id.slice(0, 8)}`
    );
    return null;
  }
  const limit = bookingUnitLimit(space);
  const runOf = (start: SlotUnit) => freeRunFrom(freed, start, limit);
  const covered = runOf(starts[startIndex]).findIndex((u) => u.endMs === endMs) + 1;
  return { starts, runOf, startIndex, count: Math.max(1, covered) };
}

/** One person of the edit sheet's "Autres personnes", as the sheet holds them. */
export interface EditPerson {
  id: string;
  displayName: string | null;
}

/**
 * The OTHER people an edit opens on: the booking's people as the server sent them to this reader
 * (`others`: holder first, the reader left out), the holder taken off - and the reader put back
 * when they are one of the participants (an organiser editing a booking they were invited to),
 * since a set without them would remove them. An erased account (id '') is left to the server,
 * which never touches its row.
 */
export function editPeople(
  booking: Pick<BookingView, 'others' | 'holderId'>,
  reader: { id: string; isParticipant: boolean } | null,
  readerLabel: string
): EditPerson[] {
  const people = bookingOthers(booking)
    .filter((p) => p.id !== '' && p.id !== booking.holderId)
    .map((p) => ({ id: p.id, displayName: p.name }));
  return reader?.isParticipant ? [{ id: reader.id, displayName: readerLabel }, ...people] : people;
}
