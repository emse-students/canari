import type { BookingPerson, BookingView } from './api';

/** How many faces the stack draws before the rest become a `+N` pill. */
const MAX_BOOKING_FACES = 3;

/**
 * THE PEOPLE A VIEWER SHARES A BOOKING WITH: the server's `others` (holder then invitees, the
 * viewer left out). Never `participantNames`, which names the invitees whoever asks - an invitee
 * read their own name there. Empty when the viewer is alone or the names are hidden.
 */
export function bookingOthers(booking: Pick<BookingView, 'others'>): BookingPerson[] {
  return booking.others ?? [];
}

/** The faces drawn and the people the `+N` pill stands for. */
export function splitBookingFaces(people: BookingPerson[]): {
  shown: BookingPerson[];
  hidden: BookingPerson[];
} {
  return { shown: people.slice(0, MAX_BOOKING_FACES), hidden: people.slice(MAX_BOOKING_FACES) };
}

/** Every name, comma-joined: the accessible label of a stack and the text of a one-line row. */
export function othersNames(people: BookingPerson[]): string {
  return people.map((p) => p.name).join(', ');
}
