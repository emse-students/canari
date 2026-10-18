/**
 * THE BOOKINGS A D29 REFUSAL NAMES (WP-B4): a change of availability, of the step or of the mode,
 * or a block over booked units, is refused while coming bookings fall inside it, and the refusal
 * carries their ids. The organiser's screen lists them, each with its cancel button, so the
 * decision D29 asks for ("the organiser cancels them explicitly and retries") is one screen away.
 */
import { BookingsApiError } from './api';
import { refusalCode } from '$lib/utils/apiRefusal';

/** The refusals that name the bookings in the way. */
export const STRANDING_CODES = ['bookings-inside-change', 'bookings-inside-block'] as const;

/** The server answers at most one page of named bookings; the rest are named by the next refusal. */
export const STRANDED_PAGE = 200;

/** The ids a refusal named, or none when it is not one of {@link STRANDING_CODES}. */
export function strandedIdsOf(error: unknown): string[] {
  const code = refusalCode(error);
  if (!(error instanceof BookingsApiError) || !code) return [];
  return (STRANDING_CODES as readonly string[]).includes(code) ? error.bookingIds : [];
}

/**
 * A booking's range as its space's clock reads it (the server's rule for every date of a space,
 * D25): "lun. 2 nov., 10:00 - 10:30"; an end on another local day names that day too.
 */
export function rangeInZone(
  startsAt: string,
  endsAt: string,
  timeZone: string,
  locale: string
): string {
  const day = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const startDay = day.format(start);
  const endDay = day.format(end);
  const endText = endDay === startDay ? time.format(end) : `${endDay}, ${time.format(end)}`;
  return `${startDay}, ${time.format(start)} - ${endText}`;
}
