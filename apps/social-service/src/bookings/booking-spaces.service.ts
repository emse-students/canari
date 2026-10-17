import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { UserTagService } from '../users/user-tag.service';
import { parseAudienceCondition, type CriteriaContext } from '../pricing/validate';
import { FILE_QUESTION_TYPE } from '../forms/form-files.service';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { Booking } from './entities/booking.entity';
import { BookingSlotsService, BOOKINGS_INSIDE_CHANGE } from './booking-slots.service';
import type { AvailabilityException, AvailabilityLine, SlotConfig } from './slots';
import { isCalendarDate, isValidTimeZone, timeToSeconds } from './zoned-time';
import type { Actor } from './bookings.service';
import type {
  AvailabilityDto,
  CreateResourceDto,
  CreateSpaceDto,
  ResourceDto,
  SpaceSettingsDto,
} from './dto/space.dto';

/** The settings that change which shapes are bookable, so they run the D29 check (WP-B2). */
const SHAPE_KEYS = ['timeZone', 'slotMode', 'stepMinutes', 'maxSteps'] as const;

/** `HH:MM` and `HH:MM:SS` stored alike, so the editor reads back what it wrote. */
const fullTime = (t: string) => (t.length === 5 ? `${t}:00` : t);

/**
 * THE ORGANISER'S SIDE OF A SPACE (WP-B4, docs/wiki/bookings-chantier.md "WP-B4 as built"): create,
 * configure and delete a space; its resources; their availability.
 *
 * Rights are `BookingsService.mayManage`'s, read once here: `MANAGE_BOOKINGS` on the owning entity,
 * the owner of a personal space, or a global admin. Creating an ENTITY space asks the same right;
 * a personal space is anyone's (D16).
 *
 * EVERY CHANGE THAT CAN STRAND A COMING BOOKING TAKES THE SPACE ROW LOCK FIRST - the lock every
 * booking takes (`BookingsService`) - then runs the D29 check: a booking cannot be made between the
 * check and the write. Refusals are typed codes, as in the rest of the module.
 */
@Injectable()
export class BookingSpacesService {
  private readonly logger = new Logger(BookingSpacesService.name);

  constructor(
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>,
    @InjectRepository(BookingResource) private readonly resources: Repository<BookingResource>,
    @InjectRepository(BookingAvailabilityRule)
    private readonly rules: Repository<BookingAvailabilityRule>,
    @InjectRepository(BookingAvailabilityException)
    private readonly exceptions: Repository<BookingAvailabilityException>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    private readonly slots: BookingSlotsService,
    private readonly associations: AssociationsService,
    private readonly userTags: UserTagService
  ) {}

  // -- Rights ------------------------------------------------------------------------------------

  /** May the actor manage spaces of this entity (or a personal one, `associationId` null)? */
  private async mayManageOwner(associationId: string | null, ownerId: string, actor: Actor) {
    if (actor.isGlobalAdmin) return true;
    if (associationId === null) return ownerId === actor.userId;
    return this.associations.mayAct(
      actor.userId,
      associationId,
      AssociationPermissionFlag.MANAGE_BOOKINGS
    );
  }

  /** The space, refused 404 when absent and 403 `not-manager` when the actor does not manage it. */
  private async managedSpace(spaceId: string, actor: Actor): Promise<BookingSpace> {
    const space = await this.spaces.findOneBy({ id: spaceId });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });
    if (!(await this.mayManageOwner(space.associationId, space.ownerId, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    return space;
  }

  /** The resource and its space, under the same refusals. */
  private async managedResource(resourceId: string, actor: Actor) {
    const resource = await this.resources.findOneBy({ id: resourceId });
    if (!resource) throw new NotFoundException({ code: 'resource-not-found' });
    const space = await this.managedSpace(resource.spaceId, actor);
    return { resource, space };
  }

  // -- Reads -------------------------------------------------------------------------------------

  /**
   * The spaces an organiser manages: those of an entity (`associationId`), or the actor's personal
   * ones. Each with its resource count, for the entity tab's list.
   */
  async managedList(associationId: string | null, actor: Actor) {
    this.logger.debug(`[BOOKINGS] managedList association=${associationId ?? 'personal'}`);
    if (associationId !== null && !(await this.mayManageOwner(associationId, '', actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const rows = await this.spaces.find({
      where:
        associationId === null
          ? { associationId: IsNull(), ownerId: actor.userId }
          : { associationId },
      order: { createdAt: 'DESC' },
    });
    if (rows.length === 0) return [];
    const counts: { spaceId: string; n: number }[] = await this.resources.manager.query(
      `SELECT "spaceId", count(*)::int AS n FROM booking_resources WHERE "spaceId" = ANY($1) GROUP BY "spaceId"`,
      [rows.map((s) => s.id)]
    );
    const countOf = new Map(counts.map((c) => [c.spaceId, c.n]));
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      slotMode: s.slotMode,
      discoverability: s.discoverability,
      resourceCount: countOf.get(s.id) ?? 0,
    }));
  }

  /** Everything the editor shows: every setting, every resource with its availability (D35). */
  async managedSpaceView(spaceId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] managedSpaceView space=${spaceId}`);
    const space = await this.managedSpace(spaceId, actor);
    const resources = await this.resources.find({
      where: { spaceId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const ids = resources.map((r) => r.id);
    const [lines, closures] = ids.length
      ? await Promise.all([
          this.rules.find({ where: { resourceId: In(ids) } }),
          this.exceptions.find({ where: { resourceId: In(ids) } }),
        ])
      : [[], []];
    return {
      ...space,
      resources: resources.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        privateInfo: r.privateInfo,
        linkedUserId: r.linkedUserId,
        position: r.position,
        lines: lines
          .filter((l) => l.resourceId === r.id)
          .map(({ weekday, onDate, startTime, endTime }) => ({
            weekday,
            onDate,
            startTime,
            endTime,
          })),
        exceptions: closures
          .filter((e) => e.resourceId === r.id)
          .map(({ fromDate, toDate }) => ({ fromDate, toDate })),
      })),
    };
  }

  // -- Settings ----------------------------------------------------------------------------------

  /**
   * The settings of `next` that the database's CHECKs would refuse, refused first as codes - a 500
   * from a constraint is a defect, a code is an answer the editor can word.
   */
  private async assertSettingsValid(next: BookingSpace) {
    if (!isValidTimeZone(next.timeZone)) throw new BadRequestException({ code: 'time-zone' });
    const stepShape =
      next.slotMode === 'step'
        ? (next.stepMinutes ?? 0) > 0 && (next.maxSteps ?? 0) >= 1
        : next.stepMinutes === null && next.maxSteps === null;
    if (!stepShape) throw new BadRequestException({ code: 'step-shape' });
    if ((next.maxMinutesPerPeriod === null) !== (next.quotaPeriod === null)) {
      throw new BadRequestException({ code: 'quota-pair' });
    }
    const items = (next.items ?? []) as { id?: string; type?: string; showIf?: unknown }[];
    // D7's file question needs the bookings half of WP-F's storage and purge (WP-B6): refused
    // until then, by a code, rather than accepted and unanswerable.
    if (items.some((i) => i.type === FILE_QUESTION_TYPE)) {
      throw new BadRequestException({ code: 'file-question-not-yet' });
    }
    if (items.some((i) => !i.id)) throw new BadRequestException({ code: 'item-id' });
    const withCondition = items.filter((i) => i.showIf != null);
    if (next.audience == null && withCondition.length === 0) return;
    const tiers = next.associationId
      ? await this.userTags.listCotisationTiers(next.associationId)
      : [];
    const ctx: CriteriaContext = {
      tierKeys: tiers.map((t) => t.variantKey),
      questions: new Map(
        items.map((i: { id?: string; options?: { id?: string }[] }) => [
          i.id as string,
          new Set((i.options ?? []).map((o) => o.id).filter((x): x is string => !!x)),
        ])
      ),
    };
    try {
      if (next.audience != null) {
        next.audience = parseAudienceCondition(next.audience, ctx, 'audience');
      }
      for (const i of withCondition) parseAudienceCondition(i.showIf, ctx, `items[${i.id}].showIf`);
    } catch (err) {
      this.logger.debug(`[BOOKINGS] audience refused: ${(err as Error).message}`);
      throw new BadRequestException({ code: 'audience-invalid' });
    }
  }

  /** Copies the settings a DTO carries onto `space`; absent keys are left as they are. */
  private applySettings(space: BookingSpace, dto: SpaceSettingsDto) {
    const { opensAt, ...rest } = dto;
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) (space as unknown as Record<string, unknown>)[k] = v;
    }
    if (opensAt !== undefined) space.opensAt = opensAt === null ? null : new Date(opensAt);
    // A slots space carries no step: switching the mode clears it, so the CHECK never sees a mix.
    if (space.slotMode === 'slots') {
      space.stepMinutes = null;
      space.maxSteps = null;
    }
  }

  /** A new space (D2, D16). An entity's space needs `MANAGE_BOOKINGS` on that entity. */
  async create(dto: CreateSpaceDto, actor: Actor) {
    const associationId = dto.associationId ?? null;
    this.logger.debug(`[BOOKINGS] create space association=${associationId ?? 'personal'}`);
    if (associationId !== null && !(await this.mayManageOwner(associationId, '', actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const space = this.spaces.create({
      ownerId: actor.userId,
      associationId,
      name: dto.name,
      slotMode: 'step',
      stepMinutes: 30,
      maxSteps: 4,
    });
    const { associationId: _ignored, ...settings } = dto;
    this.applySettings(space, settings);
    await this.assertSettingsValid(space);
    const saved = await this.spaces.save(space);
    this.logger.log(`[BOOKINGS] space created id=${saved.id.slice(0, 8)}`);
    return { id: saved.id };
  }

  /**
   * Changes settings (D35). A change of zone, mode, step or step ceiling is a change of what is
   * bookable, so it is checked against every resource's coming bookings first (D29), under the
   * space lock.
   */
  async update(spaceId: string, dto: SpaceSettingsDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] update space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    return this.spaces.manager.transaction(async (m) => {
      const space = await this.lockSpace(m, spaceId);
      const before: SlotConfig = { ...space };
      this.applySettings(space, dto);
      await this.assertSettingsValid(space);
      if (SHAPE_KEYS.some((k) => before[k] !== space[k])) {
        const resources = await m.find(BookingResource, { where: { spaceId } });
        for (const r of resources) {
          const [lines, closures] = await Promise.all([
            m.find(BookingAvailabilityRule, { where: { resourceId: r.id } }),
            m.find(BookingAvailabilityException, { where: { resourceId: r.id } }),
          ]);
          await this.slots.assertAvailabilityChangeAllowed(r.id, space, lines, closures, nowMs);
        }
      }
      await m.save(BookingSpace, space);
      this.logger.log(`[BOOKINGS] space updated id=${spaceId.slice(0, 8)}`);
      return { ok: true };
    });
  }

  /** Deletes the space and EVERYTHING under it, history included (D27). */
  async remove(spaceId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] remove space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    await this.spaces.delete({ id: spaceId });
    this.logger.log(`[BOOKINGS] space deleted id=${spaceId.slice(0, 8)}`);
    return { ok: true };
  }

  // -- Resources ---------------------------------------------------------------------------------

  /** Refuses a linked account that does not exist (D10). */
  private async assertAccount(m: EntityManager, userId: string | null | undefined) {
    if (!userId) return;
    const rows: unknown[] = await m.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (rows.length === 0) throw new BadRequestException({ code: 'unknown-account' });
  }

  private normaliseLink(dto: ResourceDto) {
    if (typeof dto.linkedUserId === 'string') {
      dto.linkedUserId = dto.linkedUserId.trim().toLowerCase() || null;
    }
  }

  async addResource(spaceId: string, dto: CreateResourceDto, actor: Actor) {
    this.logger.debug(`[BOOKINGS] addResource space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    this.normaliseLink(dto);
    await this.assertAccount(this.resources.manager, dto.linkedUserId);
    const saved = await this.resources.save(this.resources.create({ ...dto, spaceId }));
    this.logger.log(`[BOOKINGS] resource added id=${saved.id.slice(0, 8)}`);
    return { id: saved.id };
  }

  async updateResource(resourceId: string, dto: ResourceDto, actor: Actor) {
    this.logger.debug(`[BOOKINGS] updateResource resource=${resourceId}`);
    const { resource } = await this.managedResource(resourceId, actor);
    this.normaliseLink(dto);
    await this.assertAccount(this.resources.manager, dto.linkedUserId);
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) (resource as unknown as Record<string, unknown>)[k] = v;
    }
    await this.resources.save(resource);
    return { ok: true };
  }

  /**
   * Deletes a resource. Refused while it has COMING live bookings, naming them (D29 applied to the
   * whole resource); its past history goes with it, as with a space (D27).
   */
  async removeResource(resourceId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] removeResource resource=${resourceId}`);
    const { space } = await this.managedResource(resourceId, actor);
    return this.spaces.manager.transaction(async (m) => {
      await this.lockSpace(m, space.id);
      const coming = await m.find(Booking, {
        where: { resourceId, cancelledAt: IsNull(), startsAt: MoreThan(new Date(nowMs)) },
        order: { startsAt: 'ASC' },
      });
      if (coming.length) {
        throw new ConflictException({
          code: BOOKINGS_INSIDE_CHANGE,
          bookingIds: coming.map((b) => b.id),
        });
      }
      await m.delete(BookingResource, { id: resourceId });
      this.logger.log(`[BOOKINGS] resource deleted id=${resourceId.slice(0, 8)}`);
      return { ok: true };
    });
  }

  // -- Availability ------------------------------------------------------------------------------

  /** Each line one kind, a real date, a start before its end; each closure in order (D11). */
  private parseAvailability(dto: AvailabilityDto): {
    lines: AvailabilityLine[];
    exceptions: AvailabilityException[];
  } {
    const lines = dto.lines.map((l) => {
      const weekday = l.weekday ?? null;
      const onDate = l.onDate ?? null;
      if ((weekday === null) === (onDate === null)) {
        throw new BadRequestException({ code: 'line-kind' });
      }
      if (onDate !== null && !isCalendarDate(onDate)) {
        throw new BadRequestException({ code: 'line-date' });
      }
      const startTime = fullTime(l.startTime);
      const endTime = fullTime(l.endTime);
      if (timeToSeconds(startTime) >= timeToSeconds(endTime)) {
        throw new BadRequestException({ code: 'line-order' });
      }
      return { weekday, onDate, startTime, endTime };
    });
    const exceptions = dto.exceptions.map((e) => {
      if (!isCalendarDate(e.fromDate) || !isCalendarDate(e.toDate) || e.fromDate > e.toDate) {
        throw new BadRequestException({ code: 'exception-range' });
      }
      return { fromDate: e.fromDate, toDate: e.toDate };
    });
    return { lines, exceptions };
  }

  /**
   * Replaces a resource's whole availability (D11). Refused while a coming booking would fall
   * outside it, naming the bookings (D29); the check and the write share the space lock.
   */
  async setAvailability(resourceId: string, dto: AvailabilityDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] setAvailability resource=${resourceId}`);
    const { space } = await this.managedResource(resourceId, actor);
    const { lines, exceptions } = this.parseAvailability(dto);
    return this.spaces.manager.transaction(async (m) => {
      const locked = await this.lockSpace(m, space.id);
      await this.slots.assertAvailabilityChangeAllowed(
        resourceId,
        locked,
        lines,
        exceptions,
        nowMs
      );
      await m.delete(BookingAvailabilityRule, { resourceId });
      await m.delete(BookingAvailabilityException, { resourceId });
      if (lines.length) {
        await m.insert(
          BookingAvailabilityRule,
          lines.map((l) => ({ ...l, resourceId }))
        );
      }
      if (exceptions.length) {
        await m.insert(
          BookingAvailabilityException,
          exceptions.map((e) => ({ ...e, resourceId }))
        );
      }
      this.logger.log(
        `[BOOKINGS] availability set resource=${resourceId.slice(0, 8)} lines=${lines.length} exceptions=${exceptions.length}`
      );
      return { ok: true };
    });
  }

  /** The space row, locked `FOR UPDATE` inside `m` - the first lock every booking takes. */
  private async lockSpace(m: EntityManager, spaceId: string): Promise<BookingSpace> {
    const space = await m.findOne(BookingSpace, {
      where: { id: spaceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });
    return space;
  }
}
