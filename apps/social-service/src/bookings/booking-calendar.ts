/**
 * "ADD TO MY CALENDAR" FOR A BOOKING (D13, WP-B5): one signed `.ics` per booking AND per recipient.
 *
 * A calendar app - iOS Safari handing the file to Calendar, Android's calendar app - opens the link
 * with NO identity, so the route cannot ask who is calling. It asks WHAT is asked instead, as the
 * agenda subscription does (`agenda-signature.ts`): the URL carries `u`, the account the link was
 * handed to, and `sig`, an HMAC of `booking-ics|v1|<booking>|<account>` under `AGENDA_SIGNING_KEY`.
 * The server hands a link only to the booking's people and its organiser
 * (`BookingsService.calendarLink`), and on every fetch checks that `u` STILL is one of them and
 * still has an account (`BookingsService.calendarIcs`). So the link of a participant who withdrew,
 * of an account unlinked from the resource, of an organiser who lost the right, or of an erased
 * account stops working - the erased account's past bookings included - without touching anyone
 * else's link.
 *
 * WHAT THE FILE CARRIES, AND WHAT IT NEVER DOES. A link can be forwarded, so the file holds only
 * what the booker already wrote on their own agenda: the names of the place - the space's and the
 * resource's, and a resource may be a PERSON's name (D10: an alumni's column) - the start and the
 * end, and a link back to the space. NEVER the answers, the private texts (D32), nor the holder's
 * or the participants' names - on an 'occupied' space (D9) those are not the link-holder's to read.
 *
 * ROTATION. The key is the agenda's: rotating it ends every saved link of both kinds at once, which
 * is the revocation of last resort; a booking's link is then fetched again from the app ("Add to my
 * calendar" asks the API each time). A cancelled booking answers 410: a stale import cannot bring
 * it back.
 */
import { buildIcsDocument } from '../associations/ics';
import { agendaKeySignatureMatches, signWithAgendaKey } from '../associations/agenda-signature';

/** The longest account id a link may name (the accounts' own column bound). */
export const MAX_RECIPIENT_LENGTH = 255;

/**
 * The canonical string a booking's link signs: the booking AND the account it was handed to. The
 * `booking-ics|` prefix keeps it apart from agenda selections (which start `v1|campus=`); the
 * booking is a UUID and the account is percent-encoded, so neither can carry a `|` and no
 * booking/recipient pair reads as another.
 */
export function canonicalBookingCalendar(bookingId: string, recipientId: string): string {
  return `booking-ics|v1|${bookingId}|${encodeURIComponent(recipientId)}`;
}

/** The API path of a booking's signed `.ics` for one recipient, prefixed by the client's API origin. */
export function bookingCalendarPath(bookingId: string, recipientId: string): string {
  const sig = signWithAgendaKey(canonicalBookingCalendar(bookingId, recipientId));
  return `/api/bookings/${bookingId}/calendar.ics?u=${encodeURIComponent(recipientId)}&sig=${encodeURIComponent(sig)}`;
}

/**
 * Whether `sig` is the signature of this booking's link for `recipientId` (constant time). A
 * missing or oversized recipient is refused before any HMAC is computed on it.
 */
export function bookingCalendarSignatureMatches(
  bookingId: string,
  recipientId: string | undefined,
  sig: string | undefined
): boolean {
  if (!recipientId || recipientId.length > MAX_RECIPIENT_LENGTH) return false;
  return agendaKeySignatureMatches(canonicalBookingCalendar(bookingId, recipientId), sig);
}

/**
 * Where a booking is: the space, then its column - or the space alone when the column bears the
 * space's name (D44's hidden column), so a calendar never reads "Salle - Salle". The client names
 * a place by the same rule (`bookingPlace` in `frontend/src/lib/bookings/columns.ts`).
 */
export function bookingPlace(spaceName: string, resourceName: string): string {
  return resourceName === spaceName ? spaceName : `${spaceName} - ${resourceName}`;
}

/**
 * The one-event calendar of a booking: the names of the place (which may be a person's, D10), the
 * range, a link back. Nothing else.
 */
export function bookingIcs(input: {
  bookingId: string;
  spaceId: string;
  spaceName: string;
  resourceName: string;
  startsAt: Date;
  endsAt: Date;
  frontendBaseUrl: string;
}): string {
  const base = input.frontendBaseUrl.replace(/\/$/, '');
  return buildIcsDocument([
    {
      uid: `booking-${input.bookingId}`,
      summary: bookingPlace(input.spaceName, input.resourceName),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      url: `${base}/bookings/spaces/${input.spaceId}`,
    },
  ]);
}
