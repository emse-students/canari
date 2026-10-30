import type { MyBooking } from './api';

/** The most rows "Vos reservations ici" draws; the full list is the Reservations page. */
export const MINE_HERE_LIMIT = 5;

/**
 * THE READER'S COMING BOOKINGS IN ONE SPACE, soonest first: what the space page's "Vos reservations
 * ici" card lists. It reads the SAME `GET bookings/mine` answer the page already holds for the
 * holder's cancel and the private texts, so it costs no request. A cancelled booking, one the reader
 * withdrew from and one already over are not "coming" and are left out; `nowMs` only DRAWS (the
 * server decides every cancel on its own clock).
 */
export function mineHere(
  rows: Iterable<MyBooking>,
  spaceId: string,
  nowMs: number,
  limit = MINE_HERE_LIMIT
): MyBooking[] {
  return [...rows]
    .filter(
      (b) => b.space.id === spaceId && !b.cancelled && !b.withdrawn && Date.parse(b.endsAt) > nowMs
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit);
}
