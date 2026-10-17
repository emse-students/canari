import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { isBlockedBetween } from '../common/user-blocks';
import { isExclusionViolation } from '../common/pg-errors';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { matchesCondition, needsProfile, type PricingFacts } from '../pricing/audience';
import { normaliseCondition, visibleItemIds, type ConditionalItem } from '../forms/visibility';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { Booking } from './entities/booking.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { BookingSlotsService, type SlotView } from './booking-slots.service';
import { availabilityWindows, checkRangeShape, datesAround, type Range } from './slots';
import { checkBookingWindow, checkQuotas, participantMayWithdraw } from './booking-rules';
import { bookingView, privateInfoFor, relationTo, type BookingView } from './booking-views';
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
};

const DAY_MS = 86_400_000;

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
    private readonly pricingFacts: PricingFactsService
  ) {}

  // -- Rights ------------------------------------------------------------------------------------

  /** Whether the actor manages the space: see the class comment. */
  async mayManage(space: BookingSpace, actor: Actor): Promise<boolean> {
    if (actor.isGlobalAdmin) return true;
    if (space.associationId === null) return space.ownerId === actor.userId;
    return this.associations.mayAct(
      actor.userId,
      space.associationId,
      AssociationPermissionFlag.MANAGE_BOOKINGS
    );
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
    return {
      id: space.id,
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
    const [rows, people, blocks] = await Promise.all([
      bookingIds.length ? this.bookings.findBy({ id: In(bookingIds) }) : Promise.resolve([]),
      bookingIds.length
        ? this.participants.findBy({ bookingId: In(bookingIds) })
        : Promise.resolve([]),
      blockIds.length ? this.blocks.findBy({ id: In(blockIds) }) : Promise.resolve([]),
    ]);
    const byId = new Map(rows.map((b) => [b.id, b]));
    const blockById = new Map(blocks.map((b) => [b.id, b]));

    return grid.map((r) => ({
      resourceId: r.resourceId,
      units: r.units.map((u): SlotForViewer => {
        const { date, startMs, endMs } = u;
        if (u.state === 'booked') {
          const b = byId.get(u.bookingId)!;
          const relation = relationTo(b, people, actor.userId, canManage);
          return {
            date,
            startMs,
            endMs,
            state: 'booked',
            booking: bookingView(b, people, relation, space.nameVisibility, actor.userId),
          };
        }
        if (u.state === 'blocked') {
          const k = blockById.get(u.blockId);
          return {
            date,
            startMs,
            endMs,
            state: 'blocked',
            blockReason: k && (canManage || k.reasonVisible) ? k.reason : null,
          };
        }
        return { date, startMs, endMs, state: 'free' };
      }),
    }));
  }

  /**
   * The actor's bookings, as holder or as a participant (withdrawn ones included, marked), newest
   * first, with the private texts of the LIVE ones (D32).
   */
  async mine(actor: Actor) {
    this.logger.debug(`[BOOKINGS] mine user=${actor.userId.slice(0, 8)}`);
    const asParticipant = await this.participants.findBy({ userId: actor.userId });
    const ids = asParticipant.map((p) => p.bookingId);
    const rows = await this.bookings.find({
      where: [{ holderId: actor.userId }, ...(ids.length ? [{ id: In(ids) }] : [])],
      order: { startsAt: 'DESC' },
      take: 200,
    });
    if (rows.length === 0) return [];
    const [people, resources] = await Promise.all([
      this.participants.findBy({ bookingId: In(rows.map((b) => b.id)) }),
      this.resources.findBy({ id: In([...new Set(rows.map((b) => b.resourceId))]) }),
    ]);
    const resourceById = new Map(resources.map((r) => [r.id, r]));
    const spaces = await this.spaces.findBy({
      id: In([...new Set(resources.map((r) => r.spaceId))]),
    });
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    return rows.map((b) => {
      const resource = resourceById.get(b.resourceId)!;
      const space = spaceById.get(resource.spaceId)!;
      const relation = relationTo(b, people, actor.userId, false);
      const withdrawn = asParticipant.some((p) => p.bookingId === b.id && p.withdrawnAt !== null);
      return {
        ...bookingView(b, people, relation, 'names', actor.userId),
        withdrawn: b.holderId !== actor.userId && withdrawn,
        holder: b.holderId === actor.userId,
        space: { id: space.id, name: space.name, timeZone: space.timeZone },
        resource: { id: resource.id, name: resource.name },
        privateInfo: privateInfoFor(relation, b.cancelledAt !== null, space, resource),
      };
    });
  }

  /** Every booking of a space with names and answers - the organiser's list (D15, D20). */
  async spaceBookings(spaceId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] spaceBookings space=${spaceId}`);
    const space = await this.loadSpace(spaceId);
    if (!(await this.mayManage(space, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const resources = await this.resources.findBy({ spaceId });
    if (resources.length === 0) return [];
    const rows = await this.bookings.find({
      where: { resourceId: In(resources.map((r) => r.id)) },
      order: { startsAt: 'ASC' },
    });
    const people = rows.length
      ? await this.participants.findBy({ bookingId: In(rows.map((b) => b.id)) })
      : [];
    return rows.map((b) => ({
      ...bookingView(b, people, 'manager', space.nameVisibility, actor.userId),
      bookedOnBehalf: b.bookedById !== b.holderId,
      cancelledByHolder: b.cancelledById !== null && b.cancelledById === b.holderId,
    }));
  }

  // -- Writes ------------------------------------------------------------------------------------

  /**
   * Locks the space, then the resource, inside `m`'s transaction - the one order every colliding
   * write takes (class comment). Answers the resource, or 404 when it is not of this space.
   */
  private async lockResource(
    m: EntityManager,
    spaceId: string,
    resourceId: string
  ): Promise<BookingResource> {
    await m.query(`SELECT id FROM booking_spaces WHERE id = $1 FOR UPDATE`, [spaceId]);
    const rows: BookingResource[] = await m.query(
      `SELECT * FROM booking_resources WHERE id = $1 AND "spaceId" = $2 FOR UPDATE`,
      [resourceId, spaceId]
    );
    if (rows.length === 0) throw new NotFoundException({ code: 'resource-not-found' });
    return rows[0];
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
    const selections: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(answers)) {
      selections[k] = Array.isArray(v) ? v : [String(v)];
    }
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
   * Books a range of one resource (D4, D7, D12, D17, D20, D21, D26, D33). The organiser may book on
   * behalf of an account (`holderId`), outside the quotas (D17, D20); the window (D26) binds
   * everyone, the organiser included - D26 names no exemption.
   */
  async book(spaceId: string, dto: CreateBookingDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] book space=${spaceId} resource=${dto.resourceId}`);
    const space = await this.loadSpace(spaceId);
    const canManage = await this.mayManage(space, actor);
    const holderId = (dto.holderId ?? actor.userId).trim().toLowerCase();
    const onBehalf = holderId !== actor.userId;
    if (onBehalf && !canManage) throw new ForbiddenException({ code: 'not-manager' });
    if (!onBehalf) await this.assertMayUse(space, actor, canManage);
    const range = this.parseRange(dto.startsAt, dto.endsAt);

    const participantIds = [
      ...new Set((dto.participantIds ?? []).map((p) => p.trim().toLowerCase())),
    ];
    if (participantIds.includes(holderId)) {
      throw new BadRequestException({ code: 'holder-is-participant' });
    }
    if (space.maxPeople !== null && participantIds.length + 1 > space.maxPeople) {
      throw new BadRequestException({ code: 'too-many-people', maxPeople: space.maxPeople });
    }
    const answers = await this.validAnswers(space, holderId, dto.answers ?? {});

    try {
      return await this.bookings.manager.transaction(async (m) => {
        const resource = await this.lockResource(m, spaceId, dto.resourceId);

        // The shape (D3): one slot, or 1..maxSteps steps of one window.
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
        const names = await this.namesOf(m, [holderId, ...participantIds]);
        const unknown = [holderId, ...participantIds].filter((id) => !names.has(id));
        if (unknown.length) throw new BadRequestException({ code: 'unknown-account' });

        // D21: a block between the one who adds and the one added, or the holder and them. Which of
        // the two blocked is never said.
        for (const p of participantIds) {
          if (
            (await isBlockedBetween(m, actor.userId, p)) ||
            (onBehalf && (await isBlockedBetween(m, holderId, p)))
          ) {
            throw new ForbiddenException({ code: 'participant-blocked' });
          }
        }

        // D17: each person of the booking against their own live bookings of this space - under
        // the space lock, so no concurrent booking of theirs elsewhere in the space can slip in.
        if (!onBehalf) {
          for (const person of [holderId, ...participantIds]) {
            const theirs: { startsAt: Date; endsAt: Date }[] = await m.query(
              `SELECT b."startsAt", b."endsAt" FROM bookings b
                 JOIN booking_resources r ON r.id = b."resourceId"
                WHERE r."spaceId" = $1 AND b."cancelledAt" IS NULL
                  AND (b."holderId" = $2 OR EXISTS (
                        SELECT 1 FROM booking_participants p
                         WHERE p."bookingId" = b.id AND p."userId" = $2 AND p."withdrawnAt" IS NULL))`,
              [spaceId, person]
            );
            const quota = checkQuotas(
              space,
              theirs.map((b) => ({ startMs: b.startsAt.getTime(), endMs: b.endsAt.getTime() })),
              range,
              nowMs
            );
            if (quota) {
              throw new ConflictException({ code: quota, holder: person === holderId });
            }
          }
        }

        const [row]: { id: string }[] = await m.query(
          `INSERT INTO bookings ("resourceId", "holderId", "holderName", "bookedById", "startsAt", "endsAt", answers)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            resource.id,
            holderId,
            names.get(holderId),
            actor.userId,
            new Date(range.startMs),
            new Date(range.endMs),
            answers === null ? null : JSON.stringify(answers),
          ]
        );
        for (const p of participantIds) {
          await m.query(
            `INSERT INTO booking_participants ("bookingId", "userId", "userName") VALUES ($1, $2, $3)`,
            [row.id, p, names.get(p)]
          );
        }
        this.logger.log(
          `[BOOKINGS] booked id=${row.id.slice(0, 8)} resource=${resource.id.slice(0, 8)} onBehalf=${onBehalf} people=${participantIds.length + 1}`
        );
        return { id: row.id };
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        this.logger.log(`[BOOKINGS] slot taken resource=${dto.resourceId.slice(0, 8)}`);
        throw new ConflictException({ code: 'slot-taken' });
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
   */
  async cancel(bookingId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] cancel booking=${bookingId}`);
    return this.bookings.manager.transaction(async (m) => {
      const { booking, space } = await this.lockBooking(m, bookingId);
      if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
      if (new Date(booking.startsAt).getTime() <= nowMs) {
        throw new ConflictException({ code: 'history-frozen' });
      }
      const isHolder = booking.holderId === actor.userId;
      if (!isHolder && !(await this.mayManage(space, actor))) {
        throw new ForbiddenException({ code: 'not-yours' });
      }
      await m.query(`UPDATE bookings SET "cancelledAt" = $2, "cancelledById" = $3 WHERE id = $1`, [
        bookingId,
        new Date(nowMs),
        actor.userId,
      ]);
      this.logger.log(`[BOOKINGS] cancelled id=${bookingId.slice(0, 8)} byHolder=${isHolder}`);
      return { ok: true };
    });
  }

  /**
   * A participant leaves a coming booking alone (D4), until the space's minimum delay before the
   * start (D5 as the user decided on 2026-10-17); the row stays, marked (D15).
   */
  async withdraw(bookingId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] withdraw booking=${bookingId}`);
    return this.bookings.manager.transaction(async (m) => {
      const { booking, space } = await this.lockBooking(m, bookingId);
      if (booking.cancelledAt) throw new ConflictException({ code: 'already-cancelled' });
      const startMs = new Date(booking.startsAt).getTime();
      if (startMs <= nowMs) throw new ConflictException({ code: 'history-frozen' });
      if (!participantMayWithdraw(space.participantWithdrawMinMinutes, startMs, nowMs)) {
        throw new ConflictException({ code: 'withdrawal-delay' });
      }
      const result: [unknown, number] = await m.query(
        `UPDATE booking_participants SET "withdrawnAt" = $3
          WHERE "bookingId" = $1 AND "userId" = $2 AND "withdrawnAt" IS NULL`,
        [bookingId, actor.userId, new Date(nowMs)]
      );
      if (result[1] === 0) throw new NotFoundException({ code: 'not-a-participant' });
      this.logger.log(`[BOOKINGS] withdrawn booking=${bookingId.slice(0, 8)}`);
      return { ok: true };
    });
  }

  /** Whether the actor may block or unblock this resource: the organiser, or its linked account (D10). */
  private async mayBlock(space: BookingSpace, resource: BookingResource, actor: Actor) {
    return resource.linkedUserId === actor.userId || (await this.mayManage(space, actor));
  }

  /**
   * "Indisponible" over a coming range (D10, D20). Refused while live bookings fall inside it,
   * naming them (D29): the organiser cancels them explicitly first.
   */
  async addBlock(resourceId: string, dto: CreateBlockDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] addBlock resource=${resourceId}`);
    const resource = await this.resources.findOneBy({ id: resourceId });
    if (!resource) throw new NotFoundException({ code: 'resource-not-found' });
    const space = await this.loadSpace(resource.spaceId);
    if (!(await this.mayBlock(space, resource, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const range = this.parseRange(dto.startsAt, dto.endsAt);
    if (range.endMs <= nowMs) throw new ConflictException({ code: 'history-frozen' });
    if (range.endMs - range.startMs > 366 * DAY_MS) {
      throw new BadRequestException({ code: 'range' });
    }
    return this.bookings.manager.transaction(async (m) => {
      await this.lockResource(m, space.id, resourceId);
      const inside: { id: string }[] = await m.query(
        `SELECT id FROM bookings WHERE "resourceId" = $1 AND "cancelledAt" IS NULL
            AND "startsAt" < $3 AND "endsAt" > $2 ORDER BY "startsAt"`,
        [resourceId, new Date(range.startMs), new Date(range.endMs)]
      );
      if (inside.length) {
        throw new ConflictException({
          code: 'bookings-inside-block',
          bookingIds: inside.map((b) => b.id),
        });
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

  /** Lifts a block that has not ended; a past block is history like a past booking (D15). */
  async removeBlock(blockId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] removeBlock block=${blockId}`);
    const block = await this.blocks.findOneBy({ id: blockId });
    if (!block) throw new NotFoundException({ code: 'block-not-found' });
    const resource = await this.resources.findOneByOrFail({ id: block.resourceId });
    const space = await this.loadSpace(resource.spaceId);
    if (!(await this.mayBlock(space, resource, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    if (block.endsAt.getTime() <= nowMs) throw new ConflictException({ code: 'history-frozen' });
    await this.blocks.delete({ id: blockId });
    this.logger.log(`[BOOKINGS] unblocked id=${blockId.slice(0, 8)}`);
    return { ok: true };
  }
}
