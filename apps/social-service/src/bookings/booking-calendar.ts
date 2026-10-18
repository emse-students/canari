/**
 * "ADD TO MY CALENDAR" FOR A BOOKING (D13, WP-B5): one signed `.ics` per booking.
 *
 * A calendar app - iOS Safari handing the file to Calendar, Android's calendar app - opens the link
 * with NO identity, so the route cannot ask who is calling. It asks WHAT is asked instead, exactly as
 * the agenda subscription does (`agenda-signature.ts`): the URL carries `sig`, an HMAC of the
 * booking's id under `AGENDA_SIGNING_KEY`, and the server hands that signature only to the
 * booking's people and its organiser (`BookingsService.calendarLink`).
 *
 * WHAT THE FILE CARRIES, AND WHAT IT NEVER DOES. A link can be forwarded, so the file holds only
 * what the booker already wrote on their own agenda: the space's and the resource's names, the
 * start and the end, and a link back to the space. NEVER the answers, the private texts (D32), nor
 * anyone's name - on an 'occupied' space (D9) the names are not the link-holder's to read.
 *
 * ROTATION. The key is the agenda's: rotating it ends every saved link of both kinds at once, which
 * is the revocation; a booking's link is then fetched again from the app. A cancelled booking
 * answers 410: a stale import cannot bring it back.
 */
import { buildIcsDocument } from '../associations/ics';
import { agendaKeySignatureMatches, signWithAgendaKey } from '../associations/agenda-signature';

/** The canonical string a booking's link signs; the prefix keeps it apart from agenda selections. */
export function canonicalBookingCalendar(bookingId: string): string {
  return `booking-ics|v1|${bookingId}`;
}

/** The API path of a booking's signed `.ics`, as the client prefixes it with its API origin. */
export function bookingCalendarPath(bookingId: string): string {
  const sig = signWithAgendaKey(canonicalBookingCalendar(bookingId));
  return `/api/bookings/${bookingId}/calendar.ics?sig=${encodeURIComponent(sig)}`;
}

/** Whether `sig` is the signature of this booking's link (constant time). */
export function bookingCalendarSignatureMatches(bookingId: string, sig: string | undefined) {
  return agendaKeySignatureMatches(canonicalBookingCalendar(bookingId), sig);
}

/** The one-event calendar of a booking: names of the place, the range, a link back. Nothing else. */
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
      summary: `${input.spaceName} - ${input.resourceName}`,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      url: `${base}/bookings/spaces/${input.spaceId}`,
    },
  ]);
}
