import { intlLocale } from '$lib/bookings/grid';

/** The structured facts of a booking notice (`post_notifications.meta`, migration 117). */
export interface BookingNoticeMeta {
  /** The space's name (empty on a space reached by its link only, Q-R5). */
  place: string;
  /** The slot's start, an ISO instant. */
  startsAt: string;
  /** The space's IANA zone: the slot is drawn on ITS clock (D25), as the reminder is. */
  timeZone: string;
  /** The organiser's word on a cancellation (Q-R3); empty when none. */
  word: string;
}

/**
 * Reads a notice's `meta` as booking facts, or null when it is absent (a row written before the
 * column, every other type) or not of that shape - the caller then draws the row as it always did.
 * Nothing is ever read out of the row's `text` (the word, else the place: what older clients draw).
 */
export function readBookingNoticeMeta(meta: unknown): BookingNoticeMeta | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const { place, startsAt, timeZone, word } = meta as Record<string, unknown>;
  if (typeof place !== 'string' || typeof startsAt !== 'string' || typeof timeZone !== 'string') {
    return null;
  }
  if (typeof word !== 'string') return null;
  if (Number.isNaN(new Date(startsAt).getTime())) return null;
  return { place, startsAt, timeZone, word };
}

/**
 * The slot's start in the reader's language on the SPACE's clock: "mar. 3 nov., 10:00". Null when
 * the zone is not one the runtime knows, so a wrong day or hour is never shown for a right one.
 */
export function formatNoticeSlot(startsAt: string, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat(intlLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(new Date(startsAt));
  } catch (e) {
    console.warn(`[BOOKINGS] notice slot not drawn, zone "${timeZone}" refused: ${String(e)}`);
    return null;
  }
}
