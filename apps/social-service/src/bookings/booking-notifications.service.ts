import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  PostNotificationsService,
  SYSTEM_ACTOR_ID,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { BOOKINGS_TARGET } from '../push/push-target';
import { DELETED_ACCOUNT } from '../internal/account-erasure';
import { bookingPlace } from './booking-calendar';
import { localTime } from './zoned-time';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingSpace } from './entities/booking-space.entity';

/**
 * THE SWITCH OF THE BOOKINGS NOTICES (WP-N), mirrored by `BOOKING_NOTIFICATIONS_LIVE` in
 * `frontend/src/lib/bookings/notified.ts` (a contract test reads both).
 *
 * OFF until the floor allows it, by the rule every new notification type obeys
 * (docs/wiki/legacy-compatibility.md, "a notification TYPE the client does not know"): a client
 * older than PR #1911 draws an unknown type as a COMMENT with a dead link. So the four types ship
 * only once `minClientVersion` covers #1911 (its first stable, `1.2.9`) on both estates, once both
 * stores serve it - the user's gesture - and then a one-line pull request flips this constant, its
 * mirror and the spec that pins them. Off, nothing is written or sent, the reminder cron claims
 * nothing, and the screens keep saying that nobody is notified, which is then true.
 */
export const BOOKING_NOTIFICATIONS_ENABLED = true;

/** The bell row types; the push `contentKey` of each is `social_<type>` (`push-content.ts`). */
export const BOOKING_NOTICE_TYPES = [
  'booking_cancelled',
  'booking_withdrawn',
  'booking_added',
  'booking_reminder',
] as const;
export type BookingNoticeType = (typeof BOOKING_NOTICE_TYPES)[number];

/** What a notice may say of WHERE a booking is. */
interface PlaceFacts {
  spaceName: string;
  discoverability: string;
  resourceName: string;
}

/**
 * The place a notice names (D44's rule, `bookingPlace`) - or NOTHING for a space reached by its
 * link only (Q-R5): a lock screen is read by whoever holds the phone, and such a space (the
 * psychologist case) is never named there. The device then shows the key's fixed sentence.
 */
export function noticePlace(facts: PlaceFacts): string {
  if (facts.discoverability === 'link') return '';
  return bookingPlace(facts.spaceName, facts.resourceName);
}

/**
 * THE STRUCTURED FACTS OF A BOOKING NOTICE, stored in `post_notifications.meta` (migration 117) so
 * the client names WHERE and WHEN in the reader's language without parsing `text`, which holds the
 * organiser's word alone: the place (empty on a space reached by its link only, Q-R5), the slot's
 * START as a UTC instant, and the space's IANA zone the client draws it in (D25). The push never
 * carries it. Kept 90 days with the row, after the space is deleted too (C17).
 */
export interface BookingNoticeMeta extends Record<string, unknown> {
  place: string;
  startsAt: string;
  timeZone: string;
}

export function bookingNoticeMeta(
  place: string,
  startsAt: Date,
  timeZone: string
): BookingNoticeMeta {
  return { place, startsAt: startsAt.toISOString(), timeZone };
}

/** The reminder's line: the place and the start time on the space's clock, or the time alone. */
export function reminderLine(facts: PlaceFacts, startsAt: Date, timeZone: string): string {
  const time = localTime(startsAt.getTime(), timeZone).slice(0, 5);
  const place = noticePlace(facts);
  return place ? `${place} · ${time}` : time;
}

/** Who a notice names as having acted, and the picture it carries. */
interface Presented {
  actorName?: string;
  /** The row's actor when it is not the one who acted: the platform, for a neutral notice. */
  rowActorId?: string;
  associationId?: string;
  associationLogoUrl?: string | null;
  associationLogoMediaId?: string | null;
}

/** The space facts that decide how a notice presents its actor. */
type PresentingSpace = Pick<BookingSpace, 'associationId' | 'discoverability'>;

/** One booking a deleted space took with it, as read BEFORE the deletion (Q-R4). */
export interface DeletedBookingNotice {
  bookingId: string;
  startsAt: Date;
  /** The holder and every participant still in. */
  people: string[];
  resourceName: string;
}

/**
 * THE BOOKINGS NOTICES (WP-N, D53, Q-R2..Q-R5): a bell row and a push for each person a change
 * reaches, through `PostNotificationsService` - the one path every notice of the app takes, so the
 * push's wording, its category (`bookings`, Q-R15, in chat-delivery) and its fan-out are the
 * common ones. Tapped, a notice opens Reservations (`BOOKINGS_TARGET`).
 *
 * EVERY CALL IS AFTER THE WRITE HAS COMMITTED, AND BEST-EFFORT: a notice that fails is logged with
 * the booking it was about and never undoes - nor fails - the cancellation or the booking it
 * reports. The reminder is the scheduler's (`BookingReminderScheduler`), which claims before it
 * sends; these four are each triggered by one request that happens once.
 *
 * Who is told, and who is not:
 * - a CANCELLATION (by the organiser, D53; by the holder, Q-R2): the holder and every participant
 *   still in, the one who cancelled excepted. The organiser's optional word (Q-R3) is the line the
 *   notice quotes, and is stored nowhere else - on a LINK-ONLY space, in the bell row only, never
 *   on the lock screen (decided 2026-10-29: a word can name what the space hides).
 * - a WITHDRAWAL (Q-R2): the holder.
 * - a BOOKING: every participant added, and the holder of a booking made on their behalf (D20).
 * - a SPACE DELETED (Q-R4): the people of its COMING live bookings, as a cancellation.
 * - the organiser is never told of a booking or a cancellation (Q-R7).
 */
@Injectable()
export class BookingNotificationsService {
  private readonly logger = new Logger(BookingNotificationsService.name);

  /**
   * {@link BOOKING_NOTIFICATIONS_ENABLED}, read here and by the reminder cron. A field only so the
   * integration spec can exercise the notices before the switch is flipped; nothing else sets it.
   */
  enabled: boolean = BOOKING_NOTIFICATIONS_ENABLED;

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(BookingParticipant)
    private readonly participants: Repository<BookingParticipant>,
    @InjectRepository(BookingResource) private readonly resources: Repository<BookingResource>,
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>,
    private readonly notifications: PostNotificationsService
  ) {}

  /** A booking was cancelled by `actorId` (its holder or its organiser); `message` is Q-R3's word. */
  async cancelled(bookingId: string, actorId: string, message?: string): Promise<void> {
    await this.guard('cancelled', bookingId.slice(0, 8), async () => {
      const ctx = await this.context(bookingId);
      if (!ctx) return;
      const people = [ctx.booking.holderId, ...ctx.people];
      const word = message?.trim() ?? '';
      const linkOnly = ctx.space.discoverability === 'link';
      await this.send(
        'booking_cancelled',
        ctx.booking.id,
        people,
        actorId,
        { row: word, push: linkOnly ? '' : word || ctx.place },
        await this.present(ctx.space, actorId, people),
        ctx.meta
      );
    });
  }

  /** A participant left a booking (Q-R2): its holder is told. */
  async withdrawn(bookingId: string, participantId: string): Promise<void> {
    await this.guard('withdrawn', bookingId.slice(0, 8), async () => {
      const ctx = await this.context(bookingId);
      if (!ctx) return;
      await this.send(
        'booking_withdrawn',
        ctx.booking.id,
        [ctx.booking.holderId],
        participantId,
        { row: '', push: ctx.place },
        {},
        ctx.meta
      );
    });
  }

  /** A booking was made by `actorId`: its participants, and its holder when made on their behalf. */
  async added(bookingId: string, actorId: string): Promise<void> {
    await this.guard('added', bookingId.slice(0, 8), async () => {
      const ctx = await this.context(bookingId);
      if (!ctx) return;
      const people = [ctx.booking.holderId, ...ctx.people];
      await this.send(
        'booking_added',
        ctx.booking.id,
        people,
        actorId,
        { row: '', push: ctx.place },
        await this.present(ctx.space, actorId, people),
        ctx.meta
      );
    });
  }

  /**
   * A space was DELETED with coming bookings in it (Q-R4): their people are told, as of a
   * cancellation by the organiser. `notices` were read under the space's lock, before the delete,
   * since nothing of them is left after it. The deleter is the organiser of every one of them, so
   * who the notice names is decided ONCE (`present` with nobody among the people).
   */
  async spaceDeleted(
    space: Pick<BookingSpace, 'name' | 'discoverability' | 'associationId' | 'timeZone'>,
    notices: DeletedBookingNotice[],
    actorId: string
  ): Promise<void> {
    await this.guard('spaceDeleted', `space-deleted(${notices.length})`, async () => {
      if (notices.length === 0) return;
      const presented = await this.present(space, actorId, []);
      for (const notice of notices) {
        // Per booking, each in its own `try`: one that fails does not silence the others.
        try {
          const place = noticePlace({
            spaceName: space.name,
            discoverability: space.discoverability,
            resourceName: notice.resourceName,
          });
          await this.send(
            'booking_cancelled',
            notice.bookingId,
            notice.people,
            actorId,
            { row: '', push: place },
            notice.people.includes(actorId) ? {} : presented,
            bookingNoticeMeta(place, notice.startsAt, space.timeZone)
          );
        } catch (e) {
          this.logger.error(
            `[BOOKINGS_NOTIFY] space deleted: booking=${notice.bookingId.slice(0, 8)} not told: ${String(e)}`
          );
        }
      }
    });
  }

  /** The reminder of ONE person, once the scheduler has CLAIMED it (`BookingReminderScheduler`). */
  async remind(recipientId: string, bookingId: string, line: string): Promise<void> {
    await this.notifications.createNotification({
      recipientId,
      type: 'booking_reminder',
      postId: bookingId,
      actorId: SYSTEM_ACTOR_ID,
      actorName: SYSTEM_ACTOR_NAME,
      text: line,
      pushData: { target: BOOKINGS_TARGET },
    });
    this.logger.log(
      `[BOOKINGS_NOTIFY] reminder sent booking=${bookingId.slice(0, 8)} to=${recipientId.slice(0, 8)}`
    );
  }

  /** Runs `act` only while the switch is on, and turns any failure into an accusing log line. */
  private async guard(what: string, subject: string, act: () => Promise<void>): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`[BOOKINGS_NOTIFY] ${what} not sent: the switch is off (${subject})`);
      return;
    }
    try {
      await act();
    } catch (e) {
      this.logger.error(
        `[BOOKINGS_NOTIFY] ${what} not told for ${subject}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** The booking, its place, and its participants still in - or null when it is already gone. */
  private async context(bookingId: string) {
    const booking = await this.bookings.findOneBy({ id: bookingId });
    if (!booking) {
      this.logger.warn(`[BOOKINGS_NOTIFY] booking=${bookingId.slice(0, 8)} gone before its notice`);
      return null;
    }
    const resource = await this.resources.findOneByOrFail({ id: booking.resourceId });
    const space = await this.spaces.findOneByOrFail({ id: resource.spaceId });
    const people = (await this.participants.findBy({ bookingId, withdrawnAt: IsNull() })).map(
      (p) => p.userId
    );
    const place = noticePlace({
      spaceName: space.name,
      discoverability: space.discoverability,
      resourceName: resource.name,
    });
    const meta = bookingNoticeMeta(place, booking.startsAt, space.timeZone);
    return { booking, space, people, place, meta };
  }

  /**
   * Who the notice names: the actor themselves when they are one of the booking's people (a holder
   * who cancels, a member who adds a friend - someone the recipient booked with). Otherwise the
   * actor acted as the ORGANISER:
   * - on a space reached by its LINK ONLY, NOBODY (Q-R5): the platform's name, no face, no logo -
   *   an association's name or the owner's (the psychologist's) would say what the space is;
   * - on an association space, the association, its logo on the push;
   * - on a personal space, its owner, who is that actor.
   */
  private async present(
    space: PresentingSpace,
    actorId: string,
    people: string[]
  ): Promise<Presented> {
    if (people.includes(actorId)) return {};
    if (space.discoverability === 'link') {
      return { actorName: SYSTEM_ACTOR_NAME, rowActorId: SYSTEM_ACTOR_ID };
    }
    if (!space.associationId) return {};
    const [row]: { name: string; logoUrl: string | null; logoMediaId: string | null }[] =
      await this.spaces.manager.query(
        `SELECT name, "logoUrl", "logoMediaId" FROM associations WHERE id = $1`,
        [space.associationId]
      );
    if (!row) return {};
    return {
      actorName: row.name,
      associationId: space.associationId,
      associationLogoUrl: row.logoUrl,
      associationLogoMediaId: row.logoMediaId,
    };
  }

  /**
   * One bell row and one push per recipient, the one who acted and a tombstoned account excepted.
   * `text.row` is what the bell keeps (the organiser's word alone, or empty), `text.push` what a
   * lock screen shows (the place, or the word; never the slot). They differ unless there is a word on
   * a named space; then the row is written without its push and the push sent on its own, through the
   * same pipeline. `meta` rides every bell row (never the push): the place, slot and zone.
   */
  private async send(
    type: BookingNoticeType,
    bookingId: string,
    recipients: string[],
    actorId: string,
    text: { row: string; push: string },
    presented: Presented,
    meta: BookingNoticeMeta
  ): Promise<void> {
    const to = [...new Set(recipients)].filter((id) => id !== actorId && id !== DELETED_ACCOUNT);
    if (to.length === 0) {
      this.logger.debug(
        `[BOOKINGS_NOTIFY] ${type} booking=${bookingId.slice(0, 8)}: nobody to tell`
      );
      return;
    }
    const { rowActorId, ...shown } = presented;
    const common = {
      type,
      actorId: rowActorId ?? actorId,
      ...shown,
      meta,
      pushData: { target: BOOKINGS_TARGET },
    };
    let written: number;
    if (text.row === text.push) {
      written = await this.notifications.createNotifications({
        ...common,
        recipientIds: to,
        postId: bookingId,
        text: text.row,
      });
    } else {
      written = await this.notifications.createNotifications({
        ...common,
        recipientIds: to,
        postId: bookingId,
        text: text.row,
        skipPush: true,
      });
      await this.notifications.pushNotice({
        ...common,
        recipientIds: to,
        actorName: shown.actorName ?? (await this.notifications.resolveActorName(actorId)),
        text: text.push,
      });
    }
    this.logger.log(
      `[BOOKINGS_NOTIFY] ${type} booking=${bookingId.slice(0, 8)} told=${written} ` +
        `placeNamed=${text.push !== ''} wordInBellOnly=${text.row !== '' && text.row !== text.push}`
    );
  }
}

/**
 * The COMING live bookings of a space and their people, read before the space is deleted (Q-R4) -
 * the deletion cascades, and nothing of them is left to read after it.
 */
export async function deletedBookingNotices(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  spaceId: string,
  nowMs: number
): Promise<DeletedBookingNotice[]> {
  const rows = (await query(
    `SELECT b.id AS "bookingId", b."startsAt", b."holderId", r.name AS "resourceName",
            COALESCE(array_agg(p."userId") FILTER (WHERE p."userId" IS NOT NULL), '{}') AS participants
       FROM bookings b
       JOIN booking_resources r ON r.id = b."resourceId"
       LEFT JOIN booking_participants p ON p."bookingId" = b.id AND p."withdrawnAt" IS NULL
      WHERE r."spaceId" = $1 AND b."cancelledAt" IS NULL AND b."startsAt" > $2
      GROUP BY b.id, b."startsAt", b."holderId", r.name`,
    [spaceId, new Date(nowMs)]
  )) as {
    bookingId: string;
    startsAt: Date;
    holderId: string;
    resourceName: string;
    participants: string[];
  }[];
  return rows.map((r) => ({
    bookingId: r.bookingId,
    startsAt: r.startsAt,
    people: [r.holderId, ...r.participants],
    resourceName: r.resourceName,
  }));
}
