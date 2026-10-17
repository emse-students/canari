/**
 * WHAT EACH VIEWER RECEIVES OF A BOOKING - decided here, on the server, never by a screen hiding a
 * field it was sent (D9, D32). Pure, so every viewer x setting pair is a table test
 * (`booking-views.spec.ts`).
 *
 * - The ORGANISER (and a global admin) sees everything: names, answers, private texts.
 * - The booking's PEOPLE (its holder, a participant who has not withdrawn) see the names of their
 *   booking and the private texts of the space and the resource while the booking is LIVE (D32);
 *   never the answers - the holder's answers are the organiser's to read.
 * - ANYONE ELSE sees the names only when the space shows them (`nameVisibility = 'names'`), else
 *   "occupied" and nothing more. Answers and private texts: never (D9).
 */
import type { BookingNameVisibility } from './entities/booking-space.entity';

/** The viewer's relation to one booking. */
export type BookingRelation = 'manager' | 'people' | 'other';

/** The rows a view is built from. */
export interface BookingRow {
  id: string;
  resourceId: string;
  holderId: string;
  holderName: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  answers: Record<string, unknown> | null;
}

export interface ParticipantRow {
  bookingId: string;
  userId: string;
  userName: string;
  withdrawnAt: Date | null;
}

/** How `viewerId` stands to a booking. */
export function relationTo(
  booking: BookingRow,
  participants: readonly ParticipantRow[],
  viewerId: string,
  canManage: boolean
): BookingRelation {
  if (canManage) return 'manager';
  if (booking.holderId === viewerId) return 'people';
  const mine = participants.some(
    (p) => p.bookingId === booking.id && p.userId === viewerId && p.withdrawnAt === null
  );
  return mine ? 'people' : 'other';
}

/** A booking as one viewer may read it. Absent fields were never sent. */
export interface BookingView {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  /** The viewer is the holder or a participant still in. */
  mine: boolean;
  holderName?: string;
  participantNames?: string[];
  answers?: Record<string, unknown> | null;
}

/** The view of one booking for one relation and one space setting. */
export function bookingView(
  booking: BookingRow,
  participants: readonly ParticipantRow[],
  relation: BookingRelation,
  nameVisibility: BookingNameVisibility,
  viewerId: string
): BookingView {
  const inBooking = participants.filter((p) => p.bookingId === booking.id && !p.withdrawnAt);
  const mine = booking.holderId === viewerId || inBooking.some((p) => p.userId === viewerId);
  const view: BookingView = {
    id: booking.id,
    resourceId: booking.resourceId,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    cancelled: booking.cancelledAt !== null,
    mine,
  };
  if (relation !== 'other' || nameVisibility === 'names') {
    view.holderName = booking.holderName;
    view.participantNames = inBooking.map((p) => p.userName);
  }
  if (relation === 'manager') view.answers = booking.answers;
  return view;
}

/**
 * The private texts of a space and a resource (D32) for one booking's viewer: only its people (or
 * the organiser), and only while the booking is live - "gone on cancellation".
 */
export function privateInfoFor(
  relation: BookingRelation,
  cancelled: boolean,
  space: { privateInfo: string | null },
  resource: { privateInfo: string | null }
): { spacePrivateInfo: string | null; resourcePrivateInfo: string | null } | null {
  if (relation === 'other' || cancelled) return null;
  return { spacePrivateInfo: space.privateInfo, resourcePrivateInfo: resource.privateInfo };
}
