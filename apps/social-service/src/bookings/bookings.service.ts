import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { isDeadlock, isExclusionViolation } from '../common/pg-errors';
import { frontendBaseUrl } from '../common/frontend-url';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { matchesCondition, needsProfile, type PricingFacts } from '../pricing/audience';
import {
  answerSelections,
  normaliseCondition,
  profileHiddenItemIds,
  visibleItemIds,
  type ConditionalItem,
} from '../forms/visibility';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { Booking } from './entities/booking.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { BookingSlotsService, type SlotView } from './booking-slots.service';
import {
  availabilityWindows,
  checkRangeShape,
  datesAround,
  rangeLengthRefusal,
  type Range,
} from './slots';
import { checkBookingWindow, checkQuotas, participantMayWithdraw } from './booking-rules';
import {
  bookingView,
  privateInfoFor,
  relationTo,
  withAnswerFiles,
  type BookingView,
} from './booking-views';
import { BookingFilesService } from './booking-files.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { fileAnswersOf, type FileAnswer } from '../forms/form-files.service';
import { bookingsWorkbook, type BookingExportLabels } from './booking-export';
import {
  bookingCalendarPath,
  bookingCalendarSignatureMatches,
  bookingIcs,
} from './booking-calendar';
import type { CreateBlockDto, CreateBookingDto } from './dto/booking.dto';

/** Who is asking: the account nginx authenticated, and whether it is a global admin. */
export interface Actor {
  userId: string;
  isGlobalAdmin: boolean;
}

/** A unit of the grid as one viewer receives it (D9): a booking's names only when allowed. */
export type SlotForViewer = Omit<SlotView, 'bookingId' | 'blockId'> & {
  booking?: BookingView;
  /** The block's reason, when the organiser made it visible (or to the organiser). */
  blockReason?: string | null;
  /**
   * The block's id, sent only to whoever may LIFT it: the organiser, and the account linked to the
   * resource (which the server still lets lift only the blocks it created). Nobody else needs it.
   */
  blockId?: string;
};

/**
 * THE ONE RIGHTS POLICY OF THE MODULE: may `actor` manage a space owned like this - an existing
 * space, or one about to be created (`ownerId` = the creator)? A global admin, else
 * `MANAGE_BOOKINGS` on the owning association (`AssociationsService.mayAct`), else - for a PERSONAL
 * space (`associationId` null) - its owner. `ownerId` grants nothing on an association space: it
 * only names the creator.
 */
export async function mayManageSpace(
  associations: Pick<AssociationsService, 'mayAct'>,
  space: { associationId: string | null; ownerId: string },
  actor: Actor
): Promise<boolean> {
  if (actor.isGlobalAdmin) return true;
  if (space.associationId === null) return space.ownerId === actor.userId;
  return associations.mayAct(
    actor.userId,
    space.associationId,
    AssociationPermissionFlag.MANAGE_BOOKINGS
  );
}

/** A space's questions in the shape the answer readers take (`items` is stored untyped). */
const questionsOf = (space: BookingSpace) =>
  (space.items ?? []) as { id: string; label?: string; type?: string }[];

const DAY_MS = 86_400_000;

/** `listedSpaces` answers at most this many spaces, by name. */
export const LISTED_SPACES_LIMIT = 200;
/** `mine` answers at most this many bookings, newest first. */
export const MINE_LIMIT = 200;
/** One page of the organiser's list (`spaceBookings`). */
export const SPACE_BOOKINGS_PAGE = 200;
/**
 * How far before `min(now, the new booking's start)` the quota read looks back: the widest period a
 * quota counts in is an ISO week of LOCAL dates, so seven days plus a zone's offset.
 */
const QUOTA_LOOKBACK_MS = 8 * DAY_MS;
/**
 * How far behind the server's clock a block's start may be and still mean "from now": the screen's
 * now reaches the server after a request's flight and a phone's clock skew. Such a start moves up
 * to the server's now; an older one is the past and stays refused (`history-frozen`).
 */
export const NEAR_NOW_MS = 10_000;

/**
 * THE BOOKINGS API'S RULES (WP-B3, docs/wiki/bookings-chantier.md "WP-B3 as built").
 *
 * EVERY WRITE THAT CAN COLLIDE TAKES TWO ROW LOCKS FIRST, in one order: the SPACE, then the
 * RESOURCE (`SELECT ... FOR UPDATE`). The resource lock is what makes a losing racer see `23P01`
 * rather than `40P01` (measured in WP-B1); the space lock is what makes the per-person quotas
 * (D17) and a block against a booking (D29) hold across resources - without it two bookings of one
 * person on two resources could both pass a quota they break together. The exclusion constraint
 * stays the last word on overlap: a `23P01` is answered 409 `slot-taken`.
 *
 * Rights: an ASSOCIATION space is managed through `MANAGE_BOOKINGS` on its association
 * (`AssociationsService.mayAct`), NEVER through `ownerId`, which only names the creator; a PERSONAL
 * space (`associationId` NULL) by its owner. A global admin manages every space.
 *
 * Every refusal carries a `code`, never a sentence to parse: the screens map it to Paraglide.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>,
    @InjectRepository(BookingResource) private readonly resources: Repository<BookingResource>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(BookingParticipant)
    private readonly participants: Repository<BookingParticipant>,
    @InjectRepository(BookingBlock) private readonly blocks: Repository<BookingBlock>,
    private readonly slots: BookingSlotsService,
    private readonly associations: AssociationsService,
    private readonly pricingFacts: PricingFactsService,
    private readonly bookingFiles: BookingFilesService,
    private readonly notices: BookingNotificationsService
  ) {}

  // -- Rights ------------------------------------------------------------------------------------

  /** Whether the actor manages the space: {@link mayManageSpace}. */
  mayManage(space: BookingSpace, actor: Actor): Promise<boolean> {
    return mayManageSpace(this.associations, space, actor);
  }

  private async loadSpace(spaceId: string): Promise<BookingSpace> {
    const space = await this.spaces.findOneBy({ id: spaceId });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });
    return space;
  }

  /** The facts the space's audience and question conditions are judged on, for one account. */
  private async factsFor(
    space: BookingSpace,
    userId: string,
    answers: Record<string, string[]> = {}
  ): Promise<PricingFacts> {
    const conditions = [
      space.audience,
      ...((space.items ?? []) as ConditionalItem[]).map((i) => normaliseCondition(i)),
    ];
    return this.pricingFacts.build({
      userId,
      associationId: space.associationId,
      answers,
      needProfile: conditions.some(needsProfile),
    });
  }

  /**
   * Refuses an account the space is not open to (D6, D31): enforced on every read and write, never
   * by hiding the space alone - a 'link' space is reached by its link, its audience still holds.
   */
  private async assertMayUse(space: BookingSpace, actor: Actor, canManage: boolean) {
    if (canManage || !space.audience) return;
    if (matchesCondition(space.audience, await this.factsFor(space, actor.userId))) return;
    this.logger.debug(`[BOOKINGS] refused by audience space=${space.id.slice(0, 8)}`);
    throw new ForbiddenException({ code: 'audience' });
  }

  // -- Reads -------------------------------------------------------------------------------------

  /** A space and its resources as a booker reads them: no private text (D32), no audience rule. */
  async getSpace(spaceId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] getSpace space=${spaceId}`);
    const space = await this.loadSpace(spaceId);
    const canManage = await this.mayManage(space, actor);
    await this.assertMayUse(space, actor, canManage);
    const resources = await this.resources.find({
      where: { spaceId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    // The PROFILE half of each question's condition, as a form's page receives it: the booking
    // screen evaluates the answer half itself, and never asks a question the server would drop.
    const items = (space.items ?? []) as ConditionalItem[];
    const hiddenItemIds = items.some((i) => normaliseCondition(i))
      ? profileHiddenItemIds(items, await this.factsFor(space, actor.userId))
      : [];
    return {
      id: space.id,
      hiddenItemIds,
      associationId: space.associationId,
      name: space.name,
      description: space.description,
      timeZone: space.timeZone,
      slotMode: space.slotMode,
      stepMinutes: space.stepMinutes,
      maxSteps: space.maxSteps,
      nameVisibility: space.nameVisibility,
      items: space.items,
      opensAt: space.opensAt,
      minNoticeMinutes: space.minNoticeMinutes,
      horizonDays: space.horizonDays,
      participantWithdrawMinMinutes: space.participantWithdrawMinMinutes,
      maxPeople: space.maxPeople,
      // How long a file answer is kept after the slot (D8), said under the file picker.
      retentionDays: space.retentionDays,
      // The space's default reminder delay (Q-R1), offered as the booker's own in the sheet.
      reminderMinutes: space.reminderMinutes,
      poster: space.poster,
      canManage,
      resources: resources.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        linkedToMe: r.linkedUserId === actor.userId,
      })),
    };
  }

  /** The grid of a space over local dates `[from, to]`, each booking cut to what the viewer may see. */
  async spaceSlots(spaceId: string, from: string, to: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] spaceSlots space=${spaceId} ${from}..${to}`);
    const space = await this.loadSpace(spaceId);
    const canManage = await this.mayManage(space, actor);
    await this.assertMayUse(space, actor, canManage);
    const grid = await this.slots.spaceSlots(spaceId, from, to);

    const bookingIds = [
      ...new Set(
        grid.flatMap((r) => r.units.flatMap((u) => (u.state === 'booked' ? [u.bookingId] : [])))
      ),
    ];
    const blockIds = [
      ...new Set(
        grid.flatMap((r) => r.units.flatMap((u) => (u.state === 'blocked' ? [u.blockId] : [])))
      ),
    ];
    const [rows, people, blocks, resources, files] = await Promise.all([
      bookingIds.length ? this.bookings.findBy({ id: In(bookingIds) }) : Promise.resolve([]),
      bookingIds.length
        ? this.participants.findBy({ bookingId: In(bookingIds) })
        : Promise.resolve([]),
      blockIds.length ? this.blocks.findBy({ id: In(blockIds) }) : Promise.resolve([]),
      this.resources.findBy({ spaceId }),
      // Only the organiser reads answers, so only the organiser's grid names their files.
      canManage ? this.bookingFiles.answerFiles(bookingIds) : Promise.resolve(new Map()),
    ]);
    const byId = new Map(rows.map((b) => [b.id, b]));
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    const linkedOf = new Map(resources.map((r) => [r.id, r.linkedUserId]));

    return grid.map((r) => ({
      resourceId: r.resourceId,
      units: r.units.flatMap((u): SlotForViewer[] => {
        const { date, startMs, endMs } = u;
        if (u.state === 'booked') {
          const b = byId.get(u.bookingId);
          if (!b) {
            // Gone between the two reads (an account erasure deleting a personal space's rows):
            // the unit is left out of this answer, never a 500. The next read is whole again.
            this.logger.warn(`[BOOKINGS] spaceSlots: booking vanished between reads, unit skipped`);
            return [];
          }
          const linked = linkedOf.get(r.resourceId) ?? null;
          const relation = relationTo(b, people, actor.userId, canManage, linked);
          return [
            {
              date,
              startMs,
              endMs,
              state: 'booked',
              booking:
                relation === 'manager'
                  ? withAnswerFiles(
                      bookingView(b, people, relation, space.nameVisibility, actor.userId),
                      questionsOf(space),
                      files
                    )
                  : bookingView(b, people, relation, space.nameVisibility, actor.userId),
            },
          ];
        }
        if (u.state === 'blocked') {
          const k = blockById.get(u.blockId);
          return [
            {
              date,
              startMs,
              endMs,
              state: 'blocked',
              blockReason: k && (canManage || k.reasonVisible) ? k.reason : null,
              ...(canManage || linkedOf.get(r.resourceId) === actor.userId
                ? { blockId: u.blockId }
                : {}),
            },
          ];
        }
        return [{ date, startMs, endMs, state: 'free' }];
      }),
    }));
  }

  /**
   * The actor's bookings, newest first, at most {@link MINE_LIMIT}: as holder, as a participant
   * (withdrawn ones included, marked), and every booking of a resource LINKED to the actor (D10,
   * `linked: true` - the alumni's own column). Each read through the space's name visibility, with
   * the private texts of the LIVE ones the actor is one of the people of (D32).
   */
  async mine(actor: Actor) {
    this.logger.debug(`[BOOKINGS] mine user=${actor.userId.slice(0, 8)}`);
    const ids: { id: string }[] = await this.bookings.manager.query(
      `SELECT b.id FROM bookings b JOIN booking_resources r ON r.id = b."resourceId"
        WHERE b."holderId" = $1 OR r."linkedUserId" = $1
           OR EXISTS (SELECT 1 FROM booking_participants p WHERE p."bookingId" = b.id AND p."userId" = $1)
        ORDER BY b."startsAt" DESC LIMIT ${MINE_LIMIT}`,
      [actor.userId]
    );
    if (ids.length === 0) return [];
    const rows = await this.bookings.find({
      where: { id: In(ids.map((r) => r.id)) },
      order: { startsAt: 'DESC' },
    });
    const [people, resources] = await Promise.all([
      this.participants.findBy({ bookingId: In(rows.map((b) => b.id)) }),
      this.resources.findBy({ id: In([...new Set(rows.map((b) => b.resourceId))]) }),
    ]);
    const resourceById = new Map(resources.map((r) => [r.id, r]));
    const spaces = await this.spaces.findBy({
      id: In([...new Set(resources.map((r) => r.spaceId))]),
    });
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    return rows.flatMap((b) => {
      const resource = resourceById.get(b.resourceId);
      const space = resource && spaceById.get(resource.spaceId);
      if (!resource || !space) return [];
      const relation = relationTo(b, people, actor.userId, false, resource.linkedUserId);
      const own = people.find((p) => p.bookingId === b.id && p.userId === actor.userId);
      const withdrawn = own !== undefined && own.withdrawnAt !== null;
      return [
        {
          ...bookingView(b, people, relation, space.nameVisibility, actor.userId),
          withdrawn: b.holderId !== actor.userId && withdrawn,
          holder: b.holderId === actor.userId,
          linked: resource.linkedUserId === actor.userId,
          // THIS person's reminder delay (Q-R1): the holder's on the booking, a participant's on
          // their own row; null = none. A linked account that is neither has none to set.
          reminderMinutes:
            b.holderId === actor.userId ? b.reminderMinutes : (own?.reminderMinutes ?? null),
          space: { id: space.id, name: space.name, timeZone: space.timeZone },
          resource: { id: resource.id, name: resource.name },
          privateInfo: privateInfoFor(relation, b.cancelledAt !== null, space, resource),
        },
      ];
    });
  }

  /**
   * The spaces a member may book from the Reservations page (D16, D31), by name, at most
   * {@link LISTED_SPACES_LIMIT} - the limit is the SQL's, so the page never reads more:
   * - a LISTED space only: a 'link' space is never listed, whoever asks (the psychologist case);
   * - an association space only while its association is not ARCHIVED;
   * - a PERSONAL space only to its OWNER (D43): a person's free text is never published on the
   *   whole school's page, and v1 has no report button (D21). Others reach it by link or QR code.
   *
   * The audience (D6) is judged here with the facts `assertMayUse` judges a read with, so a listed
   * space always opens - but built ONCE for the page, never per space: the rights in one bulk
   * question (`mayActOnAny`), the cotisations in one pass (`cotisationTiersByAssociation`), the
   * profile in ONE core-service call, and only when a judged audience names a promo or a formation.
   *
   * IF THAT ONE CALL FAILS, the spaces whose audience needs the profile are left out - closed, as
   * `assertMayUse` would refuse them - and the failure is logged; every other space is still
   * listed. A 503 for the whole page would hide spaces that need nothing from core-service, and
   * listing a promo-restricted space to someone it may not admit would open a page that refuses
   * them. Opened by its link, such a space still answers by its own rule.
   */
  async listedSpaces(actor: Actor) {
    this.logger.debug(`[BOOKINGS] listedSpaces user=${actor.userId.slice(0, 8)}`);
    const rows = await this.spaces
      .createQueryBuilder('s')
      .leftJoin(Association, 'a', 'a.id = s.associationId')
      .where("s.discoverability = 'listed'")
      .andWhere(
        '((s.associationId IS NULL AND s.ownerId = :me) OR (s.associationId IS NOT NULL AND a.archived = false))',
        { me: actor.userId }
      )
      .orderBy('s.name', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .limit(LISTED_SPACES_LIMIT)
      .getMany();
    if (rows.length === 0) return [];

    const associationIds = [
      ...new Set(rows.flatMap((s) => (s.associationId ? [s.associationId] : []))),
    ];
    const managed = await this.associations.mayActOnAny(
      actor.userId,
      associationIds,
      AssociationPermissionFlag.MANAGE_BOOKINGS,
      { isGlobalAdmin: actor.isGlobalAdmin }
    );
    // A personal space here is the reader's own (the SQL above): they manage it.
    const judged = rows.filter(
      (s) => s.associationId !== null && !managed.has(s.associationId) && s.audience
    );
    const needProfile = judged.some((s) => needsProfile(s.audience));
    const [profile, tiers] = await Promise.all([
      this.pricingFacts.profileFor(actor.userId, needProfile).catch((e: unknown) => {
        this.logger.error(
          `[BOOKINGS] listedSpaces: profile unavailable, the spaces whose audience needs it are ` +
            `left out of this answer: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }),
      judged.length
        ? this.pricingFacts.cotisationTiersByAssociation(actor.userId, [
            ...new Set(judged.map((s) => s.associationId as string)),
          ])
        : Promise.resolve(new Map<string, (string | null)[]>()),
    ]);
    const open = rows.filter((s) => {
      if (!judged.includes(s)) return true;
      if (needsProfile(s.audience) && profile === null) return false;
      return matchesCondition(s.audience!, {
        promo: profile?.promo ?? null,
        formation: profile?.formation ?? null,
        cotisationTiers: tiers.get(s.associationId as string) ?? [],
        answers: {},
      });
    });
    if (open.length === 0) return [];

    const ids = open.map((s) => s.id);
    const [counts, names]: [{ spaceId: string; n: number }[], { id: string; name: string }[]] =
      await Promise.all([
        this.resources.manager.query(
          `SELECT "spaceId", count(*)::int AS n FROM booking_resources WHERE "spaceId" = ANY($1) GROUP BY "spaceId"`,
          [ids]
        ),
        associationIds.length
          ? this.spaces.manager.query(`SELECT id, name FROM associations WHERE id = ANY($1)`, [
              associationIds,
            ])
          : Promise.resolve([]),
      ]);
    const countOf = new Map(counts.map((c) => [c.spaceId, c.n]));
    const nameOf = new Map(names.map((a) => [a.id, a.name]));
    return open.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      associationId: s.associationId,
      associationName: s.associationId ? (nameOf.get(s.associationId) ?? null) : null,
      timeZone: s.timeZone,
      resourceCount: countOf.get(s.id) ?? 0,
      poster: s.poster,
    }));
  }

  /**
   * Whether `userId` is one of a booking's PEOPLE or its organiser - the relation that reads its
   * names (`relationTo`) - judged with NO global-admin override: the one test both a link's issue
   * and every fetch of it make, so a link is never handed to someone its fetch would refuse.
   */
  private async isOfBooking(booking: Booking, userId: string) {
    const resource = await this.resources.findOneByOrFail({ id: booking.resourceId });
    const space = await this.loadSpace(resource.spaceId);
    const people = await this.participants.findBy({ bookingId: booking.id });
    const manages = await this.mayManage(space, { userId, isGlobalAdmin: false });
    const relation = relationTo(booking, people, userId, manages, resource.linkedUserId);
    return { related: relation !== 'other', resource, space };
  }

  /**
   * The signed `.ics` link of one booking (D13) for the actor, if they are one of its people or its
   * organiser (`isOfBooking`). Who is judged before the state, as in `cancel`: a stranger learns
   * `not-yours` and nothing else. A cancelled booking has no link. The link names the actor
   * (`booking-calendar.ts`): it dies when they stop being of the booking.
   */
  async calendarLink(bookingId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] calendarLink booking=${bookingId}`);
    const booking = await this.bookings.findOneBy({ id: bookingId });
    if (!booking) throw new ForbiddenException({ code: 'not-yours' });
    if (!(await this.isOfBooking(booking, actor.userId)).related) {
      throw new ForbiddenException({ code: 'not-yours' });
    }
    if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
    return { path: bookingCalendarPath(bookingId, actor.userId) };
  }

  /**
   * The `.ics` a calendar app fetches with NO identity (`booking-calendar.ts`). The signature over
   * the booking AND the recipient `u` is checked BEFORE anything is read, so a wrong one learns
   * nothing - not even whether the booking exists. Then the recipient must STILL have an account
   * and still be of the booking (`calendar-revoked`): a participant who withdrew, an account
   * unlinked from the resource, an organiser who lost the right, an erased account (its row gone,
   * its ids tombstoned) - their links stop, past bookings included. A cancelled booking is 410: a
   * stale link cannot write it back into an agenda.
   */
  async calendarIcs(
    bookingId: string,
    recipientId: string | undefined,
    sig: string | undefined
  ): Promise<string> {
    this.logger.debug(`[BOOKINGS] calendarIcs booking=${bookingId}`);
    if (!bookingCalendarSignatureMatches(bookingId, recipientId, sig)) {
      this.logger.warn(`[BOOKINGS] calendarIcs: a signature was refused`);
      throw new ForbiddenException({ code: 'calendar-signature' });
    }
    const recipient = recipientId as string;
    const booking = await this.bookings.findOneBy({ id: bookingId });
    if (!booking) throw new NotFoundException({ code: 'booking-not-found' });
    const [account]: unknown[] = await this.bookings.manager.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [recipient]
    );
    const { related, resource, space } = await this.isOfBooking(booking, recipient);
    if (!account || !related) {
      this.logger.log(
        `[BOOKINGS] calendarIcs: a link outlived its recipient's place in booking=${bookingId.slice(0, 8)} account=${account ? 'present' : 'gone'}`
      );
      throw new ForbiddenException({ code: 'calendar-revoked' });
    }
    if (booking.cancelledAt) throw new GoneException({ code: 'booking-cancelled' });
    return bookingIcs({
      bookingId,
      spaceId: space.id,
      spaceName: space.name,
      resourceName: resource.name,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      frontendBaseUrl: frontendBaseUrl(),
    });
  }

  /**
   * One page of a space's bookings with names and answers, by start - the organiser's list (D15,
   * D20). `offset` is the position in that order; `nextOffset` is null on the last page. `ids`
   * narrows it to those bookings - the ones a D29 refusal named, which the organiser's screen lists
   * with their cancel button; an id of another space is simply not found.
   *
   * `fromMs` (WP-R5, D50) narrows it to what is STILL TO COME: the LIVE bookings (never cancelled)
   * that end after that instant - the one under way included - so the dashboard's first page is
   * the next ones, not the oldest of the space's whole history.
   */
  async spaceBookings(
    spaceId: string,
    actor: Actor,
    offset = 0,
    limit = SPACE_BOOKINGS_PAGE,
    ids?: readonly string[],
    fromMs?: number
  ) {
    this.logger.debug(
      `[BOOKINGS] spaceBookings space=${spaceId} offset=${offset} ids=${ids?.length ?? 'all'} from=${fromMs ?? 'all'}`
    );
    const space = await this.loadSpace(spaceId);
    if (!(await this.mayManage(space, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const take = Math.min(Math.max(limit, 1), SPACE_BOOKINGS_PAGE);
    const resources = await this.resources.findBy({ spaceId });
    if (resources.length === 0 || ids?.length === 0) return { items: [], nextOffset: null };
    const rows = await this.bookings.find({
      where: {
        resourceId: In(resources.map((r) => r.id)),
        ...(ids ? { id: In([...ids]) } : {}),
        ...(fromMs !== undefined
          ? { cancelledAt: IsNull(), endsAt: MoreThan(new Date(fromMs)) }
          : {}),
      },
      order: { startsAt: 'ASC', id: 'ASC' },
      skip: offset,
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const pageIds = page.map((b) => b.id);
    const [people, files] = page.length
      ? await Promise.all([
          this.participants.findBy({ bookingId: In(pageIds) }),
          this.bookingFiles.answerFiles(pageIds),
        ])
      : [[], new Map()];
    return {
      items: page.map((b) => ({
        ...withAnswerFiles(
          bookingView(b, people, 'manager', space.nameVisibility, actor.userId),
          questionsOf(space),
          files
        ),
        bookedOnBehalf: b.bookedById !== b.holderId,
        cancelledByHolder: b.cancelledById !== null && b.cancelledById === b.holderId,
      })),
      nextOffset: rows.length > take ? offset + take : null,
    };
  }

  // -- Writes ------------------------------------------------------------------------------------

  /**
   * Locks the space, then the resource, inside `m`'s transaction - the one order every colliding
   * write takes (class comment). Answers BOTH rows as read under the lock, so every setting a write
   * decides on is the one it holds; 404 when the resource is not of this space.
   */
  private async lockResource(
    m: EntityManager,
    spaceId: string,
    resourceId: string
  ): Promise<{ space: BookingSpace; resource: BookingResource }> {
    const space = await m.findOne(BookingSpace, {
      where: { id: spaceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });
    const resource = await m.findOne(BookingResource, {
      where: { id: resourceId, spaceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!resource) throw new NotFoundException({ code: 'resource-not-found' });
    return { space, resource };
  }

  /** Parses a request's range: two instants, the end after the start. */
  private parseRange(startsAt: string, endsAt: string): Range {
    const range = { startMs: Date.parse(startsAt), endMs: Date.parse(endsAt) };
    if (!Number.isFinite(range.startMs) || !(range.endMs > range.startMs)) {
      throw new BadRequestException({ code: 'range' });
    }
    return range;
  }

  /** `First Last` of each account that exists, by id. */
  private async namesOf(m: EntityManager, ids: string[]): Promise<Map<string, string>> {
    const rows: { id: string; firstName: string | null; lastName: string | null }[] = await m.query(
      `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
      [ids]
    );
    return new Map(
      rows.map((r) => [r.id, [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.id])
    );
  }

  /**
   * D21 for a whole booking in ONE query: is any participant blocked with any of `sources` (the one
   * who adds them, and the holder when booked on behalf)? Symmetric, like `isBlockedBetween`, whose
   * rule this is - batched here because it runs under the space-wide lock.
   */
  private async anyBlocked(m: EntityManager, sources: string[], participants: string[]) {
    if (participants.length === 0) return false;
    const rows: unknown[] = await m.query(
      `SELECT 1 FROM user_blocks
        WHERE ("blockerId" = ANY($1) AND "blockedId" = ANY($2))
           OR ("blockerId" = ANY($2) AND "blockedId" = ANY($1))
        LIMIT 1`,
      [sources, participants]
    );
    return rows.length > 0;
  }

  /**
   * D17 for a whole booking in ONE query: each person's live bookings of the space that a quota can
   * still count (ending after `sinceMs`), keyed by person. A person counts as holder or as a
   * participant who has not withdrawn.
   */
  private async liveRangesOf(
    m: EntityManager,
    spaceId: string,
    persons: string[],
    sinceMs: number
  ): Promise<Map<string, Range[]>> {
    const rows: { person: string; startsAt: Date; endsAt: Date }[] = await m.query(
      `SELECT x.person, b."startsAt", b."endsAt"
         FROM unnest($2::varchar[]) AS x(person)
         JOIN bookings b ON b."cancelledAt" IS NULL AND b."endsAt" > $3
         JOIN booking_resources r ON r.id = b."resourceId" AND r."spaceId" = $1
        WHERE b."holderId" = x.person OR EXISTS (
              SELECT 1 FROM booking_participants p
               WHERE p."bookingId" = b.id AND p."userId" = x.person AND p."withdrawnAt" IS NULL)`,
      [spaceId, persons, new Date(sinceMs)]
    );
    const out = new Map<string, Range[]>(persons.map((p) => [p, []]));
    for (const r of rows) {
      out.get(r.person)?.push({ startMs: r.startsAt.getTime(), endMs: r.endsAt.getTime() });
    }
    return out;
  }

  /**
   * The answers kept for a booking: the questions the holder can see, each required one answered
   * (the forms' rule, `visibleItemIds`). An answer to an undeclared or hidden question is dropped.
   */
  private async validAnswers(
    space: BookingSpace,
    holderId: string,
    answers: Record<string, string | string[] | number>
  ): Promise<Record<string, string | string[] | number> | null> {
    const items = (space.items ?? []) as (ConditionalItem & { required?: boolean })[];
    if (items.length === 0) return null;
    // Keyed by the space's own question ids only: a `__proto__` key off the body never reaches
    // a map (`answerSelections`, the forms' rule).
    const selections = answerSelections(items, answers);
    const visible = visibleItemIds(items, await this.factsFor(space, holderId, selections));
    const kept: Record<string, string | string[] | number> = {};
    for (const item of items) {
      if (!visible.has(item.id)) continue;
      const value = answers[item.id];
      const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '';
      if (item.required && !present) {
        throw new BadRequestException({ code: 'answer-required', itemId: item.id });
      }
      if (present) kept[item.id] = value;
    }
    return kept;
  }

  /**
   * The file answers among the answers KEPT (`validAnswers`): one per FILE question answered, each
   * a file id - refused `file-answer` when a value is not one. Ownership is `attach`'s, at the write.
   */
  private fileAnswersIn(
    space: BookingSpace,
    answers: Record<string, unknown> | null
  ): FileAnswer[] {
    if (answers === null) return [];
    try {
      return fileAnswersOf((space.items ?? []) as { id: string; type?: string }[], answers);
    } catch (err) {
      if (err instanceof BadRequestException) {
        this.logger.debug(`[BOOKINGS] book refused: a file answer that names no file`);
        throw new BadRequestException({ code: 'file-answer' });
      }
      throw err;
    }
  }

  /**
   * Books a range of one resource (D4, D7, D12, D17, D20, D21, D26, D33). The organiser may book on
   * behalf of an account (`holderId`), outside the quotas (D17, D20); the window (D26) binds
   * everyone, the organiser included - D26 names no exemption.
   *
   * Rights, the audience and the answers are judged BEFORE the lock (the answers may need the
   * profile service, which a lock must not wait on); every other rule reads the space AS LOCKED. If
   * the questions changed in between, the answers were judged against the wrong ones: refused
   * `space-changed`, and the booker retries on the new questions.
   */
  async book(spaceId: string, dto: CreateBookingDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] book space=${spaceId} resource=${dto.resourceId}`);
    const before = await this.loadSpace(spaceId);
    const canManage = await this.mayManage(before, actor);
    const holderId = (dto.holderId ?? actor.userId).trim().toLowerCase();
    const onBehalf = holderId !== actor.userId;
    if (onBehalf && !canManage) throw new ForbiddenException({ code: 'not-manager' });
    if (!onBehalf) await this.assertMayUse(before, actor, canManage);
    const range = this.parseRange(dto.startsAt, dto.endsAt);

    const participantIds = [
      ...new Set((dto.participantIds ?? []).map((p) => p.trim().toLowerCase())),
    ];
    if (participantIds.includes(holderId)) {
      throw new BadRequestException({ code: 'holder-is-participant' });
    }
    const answers = await this.validAnswers(before, holderId, dto.answers ?? {});
    const fileAnswers = this.fileAnswersIn(before, answers);
    const people = [holderId, ...participantIds];

    try {
      const booked = await this.bookings.manager.transaction(async (m) => {
        const { space, resource } = await this.lockResource(m, spaceId, dto.resourceId);
        if (JSON.stringify(space.items ?? []) !== JSON.stringify(before.items ?? [])) {
          throw new ConflictException({ code: 'space-changed' });
        }
        if (space.maxPeople !== null && people.length > space.maxPeople) {
          throw new BadRequestException({ code: 'too-many-people', maxPeople: space.maxPeople });
        }

        // The shape (D3): one slot, or 1..maxSteps consecutive steps of one opening. The length
        // bound comes first, from the settings alone: an over-long range is refused before any
        // window is built.
        const tooLong = rangeLengthRefusal(space, range);
        if (tooLong) {
          this.logger.debug(`[BOOKINGS] book refused before any window: ${tooLong}`);
          throw new BadRequestException({ code: tooLong });
        }
        const [from, to] = datesAround(range, space.timeZone);
        const [rules, exceptions] = await Promise.all([
          m.query(
            `SELECT weekday, "onDate"::text AS "onDate", "startTime"::text AS "startTime", "endTime"::text AS "endTime"
               FROM booking_availability_rules WHERE "resourceId" = $1`,
            [resource.id]
          ),
          m.query(
            `SELECT "fromDate"::text AS "fromDate", "toDate"::text AS "toDate"
               FROM booking_availability_exceptions WHERE "resourceId" = $1`,
            [resource.id]
          ),
        ]);
        const shape = checkRangeShape(
          space,
          availabilityWindows(space, rules, exceptions, from, to),
          range
        );
        if (shape) throw new BadRequestException({ code: shape });

        const window = checkBookingWindow(space, range, nowMs);
        if (window) throw new ConflictException({ code: window });

        const blocked: unknown[] = await m.query(
          `SELECT 1 FROM booking_blocks WHERE "resourceId" = $1 AND "startsAt" < $3 AND "endsAt" > $2 LIMIT 1`,
          [resource.id, new Date(range.startMs), new Date(range.endMs)]
        );
        if (blocked.length) throw new ConflictException({ code: 'blocked' });

        // Every account named must exist; names are snapshots taken now (D15).
        const names = await this.namesOf(m, people);
        if (people.some((id) => !names.has(id))) {
          throw new BadRequestException({ code: 'unknown-account' });
        }

        // D21: a block between the one who adds and the one added, or the holder and them. Which of
        // the two blocked is never said.
        const sources = onBehalf ? [actor.userId, holderId] : [actor.userId];
        if (await this.anyBlocked(m, sources, participantIds)) {
          throw new ForbiddenException({ code: 'participant-blocked' });
        }

        // D17: each person of the booking against their own live bookings of this space - under
        // the space lock, so no concurrent booking of theirs elsewhere in the space can slip in.
        if (!onBehalf) {
          const ranges = await this.liveRangesOf(
            m,
            spaceId,
            people,
            Math.min(nowMs, range.startMs) - QUOTA_LOOKBACK_MS
          );
          for (const person of people) {
            const quota = checkQuotas(space, ranges.get(person) ?? [], range, nowMs);
            if (quota) {
              throw new ConflictException({ code: quota, holder: person === holderId });
            }
          }
        }

        // Each person's reminder delay (Q-R1): the space's default, or the booker's own choice
        // for themselves - never for an account booked on behalf of, who chooses theirs later.
        // Chosen NOW, which is what Q-R6 reads: a booking made inside its delay gets no reminder.
        const holderReminder =
          !onBehalf && dto.reminderMinutes !== undefined
            ? dto.reminderMinutes
            : space.reminderMinutes;
        const [row]: { id: string }[] = await m.query(
          `INSERT INTO bookings ("resourceId", "holderId", "holderName", "bookedById", "startsAt", "endsAt", answers,
                                 "reminderMinutes", "reminderSetAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            resource.id,
            holderId,
            names.get(holderId),
            actor.userId,
            new Date(range.startMs),
            new Date(range.endMs),
            answers === null ? null : JSON.stringify(answers),
            holderReminder,
            new Date(nowMs),
          ]
        );
        if (participantIds.length) {
          await m.query(
            `INSERT INTO booking_participants ("bookingId", "userId", "userName", "reminderMinutes", "reminderSetAt")
             SELECT $1, u, n, $4::int, $5::timestamptz FROM unnest($2::varchar[], $3::varchar[]) AS x(u, n)`,
            [
              row.id,
              participantIds,
              participantIds.map((p) => names.get(p)),
              space.reminderMinutes,
              new Date(nowMs),
            ]
          );
        }
        // D7: each file answer must be the ACTOR's own upload for this space and question; taken in
        // this transaction, so a refusal rolls the booking back with it.
        await this.bookingFiles.attach(m, row.id, spaceId, actor.userId, fileAnswers);
        this.logger.log(
          `[BOOKINGS] booked id=${row.id.slice(0, 8)} resource=${resource.id.slice(0, 8)} onBehalf=${onBehalf} people=${people.length}`
        );
        return { id: row.id };
      });
      // After the commit, best-effort (`BookingNotificationsService`): the people added are told.
      await this.notices.added(booked.id, actor.userId);
      return booked;
    } catch (err) {
      if (isExclusionViolation(err)) {
        this.logger.log(`[BOOKINGS] slot taken resource=${dto.resourceId.slice(0, 8)}`);
        throw new ConflictException({ code: 'slot-taken' });
      }
      // Every writer of these tables takes space, then resource, then booking (the erasure too,
      // `BOOKINGS_ERASURE_STATEMENTS`), so a deadlock here is a writer that broke the order. The
      // transaction was rolled back whole: the booker may send the same request again.
      if (isDeadlock(err)) {
        this.logger.error(
          `[BOOKINGS] deadlock while booking resource=${dto.resourceId.slice(0, 8)}`
        );
        throw new ConflictException({ code: 'try-again' });
      }
      throw err;
    }
  }

  /** The booking and its space, the booking row LOCKED, inside `m`. */
  private async lockBooking(m: EntityManager, bookingId: string) {
    const rows: (Booking & { spaceId: string })[] = await m.query(
      `SELECT b.*, r."spaceId" FROM bookings b JOIN booking_resources r ON r.id = b."resourceId"
        WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (rows.length === 0) throw new NotFoundException({ code: 'booking-not-found' });
    const booking = rows[0];
    const space = await this.loadSpace(booking.spaceId);
    return { booking, space };
  }

  /**
   * Cancels a coming booking (D5 as the user decided on 2026-10-17, D15, D20): its holder or the
   * organiser, AT ANY TIME before the start - no delay binds either. The row stays as history, with
   * who cancelled; nothing past moves.
   *
   * WHO is judged BEFORE the booking's state: booking ids are published in the grid, so a stranger
   * must learn nothing of a booking's state from the refusal - only `not-yours`.
   *
   * Once committed, its people are told (D53, Q-R2), the one who cancelled excepted; `message` is
   * the organiser's optional word (Q-R3), quoted by the notice and stored nowhere.
   */
  async cancel(bookingId: string, actor: Actor, nowMs: number, message?: string) {
    this.logger.debug(`[BOOKINGS] cancel booking=${bookingId}`);
    const done = await this.bookings.manager.transaction(async (m) => {
      const { booking, space } = await this.lockBooking(m, bookingId);
      const isHolder = booking.holderId === actor.userId;
      if (!isHolder && !(await this.mayManage(space, actor))) {
        throw new ForbiddenException({ code: 'not-yours' });
      }
      if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
      if (new Date(booking.startsAt).getTime() <= nowMs) {
        throw new ConflictException({ code: 'history-frozen' });
      }
      await m.query(`UPDATE bookings SET "cancelledAt" = $2, "cancelledById" = $3 WHERE id = $1`, [
        bookingId,
        new Date(nowMs),
        actor.userId,
      ]);
      this.logger.log(`[BOOKINGS] cancelled id=${bookingId.slice(0, 8)} byHolder=${isHolder}`);
      return { isHolder };
    });
    // Only the organiser's word is Q-R3's: a holder cancelling their own booking sends none.
    await this.notices.cancelled(bookingId, actor.userId, done.isHolder ? undefined : message);
    return { ok: true };
  }

  /**
   * A participant leaves a coming booking alone (D4), until the space's minimum delay before the
   * start (D5 as the user decided on 2026-10-17); the row stays, marked (D15). Whether the actor is
   * a participant still in is judged first, for the reason `cancel` gives. Once committed, the
   * holder is told (Q-R2).
   */
  async withdraw(bookingId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] withdraw booking=${bookingId}`);
    await this.bookings.manager.transaction(async (m) => {
      const { booking, space } = await this.lockBooking(m, bookingId);
      const mine: unknown[] = await m.query(
        `SELECT 1 FROM booking_participants
          WHERE "bookingId" = $1 AND "userId" = $2 AND "withdrawnAt" IS NULL FOR UPDATE`,
        [bookingId, actor.userId]
      );
      if (mine.length === 0) throw new NotFoundException({ code: 'not-a-participant' });
      if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
      const startMs = new Date(booking.startsAt).getTime();
      if (startMs <= nowMs) throw new ConflictException({ code: 'history-frozen' });
      if (!participantMayWithdraw(space.participantWithdrawMinMinutes, startMs, nowMs)) {
        throw new ConflictException({ code: 'withdrawal-delay' });
      }
      await m.query(
        `UPDATE booking_participants SET "withdrawnAt" = $3
          WHERE "bookingId" = $1 AND "userId" = $2 AND "withdrawnAt" IS NULL`,
        [bookingId, actor.userId, new Date(nowMs)]
      );
      this.logger.log(`[BOOKINGS] withdrawn booking=${bookingId.slice(0, 8)}`);
    });
    await this.notices.withdrawn(bookingId, actor.userId);
    return { ok: true };
  }

  /**
   * Sets THIS person's reminder delay on a booking (Q-R1): its holder on the booking, a participant
   * still in on their own row; `null` = no reminder. Refused on a cancelled or started booking -
   * nothing is left to remind. Choosing re-arms: the claim is cleared and `reminderSetAt` is now, so
   * an instant already past when chosen sends nothing (Q-R6), and one still to come sends once.
   * WHO is judged before the booking's state, for the reason `cancel` gives.
   */
  async setReminder(bookingId: string, minutes: number | null, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] setReminder booking=${bookingId} minutes=${minutes}`);
    return this.bookings.manager.transaction(async (m) => {
      const { booking } = await this.lockBooking(m, bookingId);
      const isHolder = booking.holderId === actor.userId;
      if (!isHolder) {
        const mine: unknown[] = await m.query(
          `SELECT 1 FROM booking_participants
            WHERE "bookingId" = $1 AND "userId" = $2 AND "withdrawnAt" IS NULL FOR UPDATE`,
          [bookingId, actor.userId]
        );
        if (mine.length === 0) throw new ForbiddenException({ code: 'not-yours' });
      }
      if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
      if (new Date(booking.startsAt).getTime() <= nowMs) {
        throw new ConflictException({ code: 'history-frozen' });
      }
      const set = `"reminderMinutes" = $2, "reminderSetAt" = $3, "reminderSentAt" = NULL`;
      if (isHolder) {
        await m.query(`UPDATE bookings SET ${set} WHERE id = $1`, [
          bookingId,
          minutes,
          new Date(nowMs),
        ]);
      } else {
        await m.query(
          `UPDATE booking_participants SET ${set}
            WHERE "bookingId" = $1 AND "userId" = $4 AND "withdrawnAt" IS NULL`,
          [bookingId, minutes, new Date(nowMs), actor.userId]
        );
      }
      this.logger.log(
        `[BOOKINGS] reminder set booking=${bookingId.slice(0, 8)} holder=${isHolder} minutes=${minutes}`
      );
      return { ok: true, reminderMinutes: minutes };
    });
  }

  /**
   * "Indisponible" over a coming range (D10, D20): the organiser, or the account linked to the
   * resource. NOTHING ON THE PAST (D15, D20): a block may not START before now - the screen offers
   * now as its earliest start, and a start within `NEAR_NOW_MS` of the server's now moves up to it -
   * so no past instant is ever marked. Refused while COMING live
   * bookings fall inside it, naming them (D29): the organiser cancels them explicitly first. A
   * booking already under way cannot be cancelled, so it neither refuses the block nor is named.
   * A block overlapping one of the resource's own is refused `block-overlap` (the same block twice).
   */
  async addBlock(resourceId: string, dto: CreateBlockDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] addBlock resource=${resourceId}`);
    const resource = await this.resources.findOneBy({ id: resourceId });
    if (!resource) throw new NotFoundException({ code: 'resource-not-found' });
    const space = await this.loadSpace(resource.spaceId);
    if (resource.linkedUserId !== actor.userId && !(await this.mayManage(space, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const range = this.parseRange(dto.startsAt, dto.endsAt);
    // The screen offers ITS now as the earliest start, which reaches the server a moment late: a
    // start that close is the booker's "from now" and moves up to the server's now. Anything
    // clearly in the past is still refused.
    if (range.startMs < nowMs - NEAR_NOW_MS) {
      throw new ConflictException({ code: 'history-frozen' });
    }
    if (range.startMs < nowMs) {
      this.logger.debug(`[BOOKINGS] addBlock start moved up to now by ${nowMs - range.startMs}ms`);
      range.startMs = nowMs;
      if (range.endMs <= range.startMs) throw new BadRequestException({ code: 'range' });
    }
    if (range.endMs - range.startMs > 366 * DAY_MS) {
      throw new BadRequestException({ code: 'range' });
    }
    return this.bookings.manager.transaction(async (m) => {
      await this.lockResource(m, space.id, resourceId);
      const inside: { id: string }[] = await m.query(
        `SELECT id FROM bookings WHERE "resourceId" = $1 AND "cancelledAt" IS NULL
            AND "startsAt" > $4 AND "startsAt" < $3 AND "endsAt" > $2 ORDER BY "startsAt"`,
        [resourceId, new Date(range.startMs), new Date(range.endMs), new Date(nowMs)]
      );
      if (inside.length) {
        throw new ConflictException({
          code: 'bookings-inside-block',
          bookingIds: inside.map((b) => b.id),
        });
      }
      // IDEMPOTENCE FROM DURABLE STATE: a block over a block of the same resource is the same
      // "Indisponible" written twice (a retry after a lost answer). Any overlap is refused; the
      // range starts at or after now, so a block that overlaps it has not ended.
      const [overlap]: { id: string }[] = await m.query(
        `SELECT id FROM booking_blocks
          WHERE "resourceId" = $1 AND "startsAt" < $3 AND "endsAt" > $2 LIMIT 1`,
        [resourceId, new Date(range.startMs), new Date(range.endMs)]
      );
      if (overlap) {
        this.logger.debug(
          `[BOOKINGS] addBlock refused: overlaps block=${overlap.id.slice(0, 8)} resource=${resourceId.slice(0, 8)}`
        );
        throw new ConflictException({ code: 'block-overlap' });
      }
      const [row]: { id: string }[] = await m.query(
        `INSERT INTO booking_blocks ("resourceId", "startsAt", "endsAt", reason, "reasonVisible", "createdById")
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          resourceId,
          new Date(range.startMs),
          new Date(range.endMs),
          dto.reason ?? null,
          dto.reasonVisible ?? false,
          actor.userId,
        ]
      );
      this.logger.log(
        `[BOOKINGS] blocked resource=${resourceId.slice(0, 8)} id=${row.id.slice(0, 8)}`
      );
      return { id: row.id };
    });
  }

  /**
   * Lifts a block. The organiser lifts any; the linked account only one IT created - never the
   * organiser's "Indisponible". Only the part still to come moves (D15): a block under way is
   * ended NOW, its past part stays as history; a block that has ended is refused.
   */
  async removeBlock(blockId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] removeBlock block=${blockId}`);
    const block = await this.blocks.findOneBy({ id: blockId });
    if (!block) throw new NotFoundException({ code: 'block-not-found' });
    const resource = await this.resources.findOneByOrFail({ id: block.resourceId });
    const space = await this.loadSpace(resource.spaceId);
    const ownLinkedBlock =
      resource.linkedUserId === actor.userId && block.createdById === actor.userId;
    if (!ownLinkedBlock && !(await this.mayManage(space, actor))) {
      throw new ForbiddenException({ code: 'not-yours' });
    }
    if (block.endsAt.getTime() <= nowMs) throw new ConflictException({ code: 'history-frozen' });
    if (block.startsAt.getTime() < nowMs) {
      await this.blocks.update({ id: blockId }, { endsAt: new Date(nowMs) });
      this.logger.log(`[BOOKINGS] block ended now id=${blockId.slice(0, 8)}`);
      return { ok: true };
    }
    await this.blocks.delete({ id: blockId });
    this.logger.log(`[BOOKINGS] unblocked id=${blockId.slice(0, 8)}`);
    return { ok: true };
  }

  // -- Files and export (WP-B6) ------------------------------------------------------------------

  /**
   * Stores the file of one FILE question (D7) before the booking is sent: whoever the space is open
   * to (its audience, as a booking), or its organiser (who books on someone's behalf).
   */
  async uploadFile(
    spaceId: string,
    itemId: string | undefined,
    file: { buffer: Buffer; size: number; originalname?: string },
    actor: Actor
  ) {
    this.logger.debug(`[BOOKINGS] uploadFile space=${spaceId} item=${itemId}`);
    const space = await this.loadSpace(spaceId);
    await this.assertMayUse(space, actor, await this.mayManage(space, actor));
    return this.bookingFiles.upload(space, itemId, file, actor.userId);
  }

  /**
   * One booking's file, for its ORGANISER - the only reader a booking's answers have (D9: answers
   * and files are never another booker's; the holder's answers are the organiser's to read).
   * ORGANISER means the space's own managers: a global admin's override does NOT open a file (D22,
   * register C17 "organiser alone", review of #2045) - a CV is not the platform's to read.
   */
  async downloadFile(bookingId: string, fileId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] downloadFile booking=${bookingId.slice(0, 8)}`);
    const booking = await this.bookings.findOneBy({ id: bookingId });
    // Who before what: a stranger learns `not-manager`, never whether the booking exists.
    const resource = booking ? await this.resources.findOneBy({ id: booking.resourceId }) : null;
    const space = resource ? await this.spaces.findOneBy({ id: resource.spaceId }) : null;
    if (!space || !(await this.mayManage(space, { ...actor, isGlobalAdmin: false }))) {
      if (actor.isGlobalAdmin) {
        this.logger.log(`[BOOKINGS] downloadFile refused to a global admin outside the organisers`);
      }
      throw new ForbiddenException({ code: 'not-manager' });
    }
    return this.bookingFiles.download(bookingId, fileId);
  }

  /**
   * The XLSX of a space's bookings (D24), for its organiser: every booking the space still holds -
   * past, coming, cancelled - by start, in the words the client sent (`labels`). Before the purge,
   * the answers are in it; after, they are gone (D18). The files never are, only a word for each.
   */
  async exportBookings(spaceId: string, labels: BookingExportLabels, actor: Actor) {
    this.logger.debug(`[BOOKINGS] exportBookings space=${spaceId}`);
    const space = await this.loadSpace(spaceId);
    if (!(await this.mayManage(space, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const resources = await this.resources.findBy({ spaceId });
    const nameOf = new Map(resources.map((r) => [r.id, r.name]));
    const rows = resources.length
      ? await this.bookings.find({
          where: { resourceId: In(resources.map((r) => r.id)) },
          order: { startsAt: 'ASC', id: 'ASC' },
        })
      : [];
    const ids = rows.map((b) => b.id);
    const [people, files] = ids.length
      ? await Promise.all([
          this.participants.findBy({ bookingId: In(ids) }),
          this.bookingFiles.answerFiles(ids),
        ])
      : [[], new Map()];
    const buffer = await bookingsWorkbook(
      space.name,
      rows.map((b) => ({
        id: b.id,
        resourceName: nameOf.get(b.resourceId) ?? '',
        holderName: b.holderName,
        participantNames: people
          .filter((p) => p.bookingId === b.id && p.withdrawnAt === null)
          .map((p) => p.userName),
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        cancelled: b.cancelledAt !== null,
        answers: b.answers,
      })),
      questionsOf(space),
      space.timeZone,
      labels,
      files
    );
    this.logger.log(`[BOOKINGS] export space=${spaceId.slice(0, 8)} rows=${rows.length}`);
    return { buffer, name: space.name };
  }
}
