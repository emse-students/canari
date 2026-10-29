import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { UserTagService } from '../users/user-tag.service';
import { isForeignKeyViolation } from '../common/pg-errors';
import { criteriaContextFor, parseAudienceCondition } from '../pricing/validate';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { Booking } from './entities/booking.entity';
import { BookingSlotsService } from './booking-slots.service';
import type { AvailabilityException, AvailabilityLine, SlotConfig } from './slots';
import { isCalendarDate, isValidTimeZone, timeToSeconds } from './zoned-time';
import { mayManageSpace, type Actor } from './bookings.service';
import {
  MAX_PERSONAL_SPACES,
  MAX_RESOURCES_PER_SPACE,
  type AvailabilityDto,
  type CreateResourceDto,
  type CreateSpaceDto,
  type ResourceDto,
  type SpaceSettingsDto,
} from './dto/space.dto';
import { ZONED_INSTANT } from './dto/booking.dto';
import { BookingPosterMedia, posterOf } from './booking-poster-media';

/** The settings that change which shapes are bookable, so they run the D29 check (WP-B2). */
const SHAPE_KEYS = ['timeZone', 'slotMode', 'stepMinutes', 'maxSteps'] as const;

/**
 * THE SETTINGS A REQUEST MAY WRITE ONTO A SPACE, by name - never the keys of the body (review of
 * #2006: a body's own keys written onto the entity let `ownerId`, `associationId` or `id` through
 * whenever the ValidationPipe's whitelist is not there to strip them). `opensAt` and the `poster`
 * are converted on their own, so they are not in the list. `booking-spaces.keys.spec.ts` holds this list against the DTO.
 */
export const SPACE_SETTING_KEYS = [
  'name',
  'description',
  'timeZone',
  'slotMode',
  'stepMinutes',
  'maxSteps',
  'nameVisibility',
  'discoverability',
  'audience',
  'items',
  'privateInfo',
  'minNoticeMinutes',
  'horizonDays',
  'maxActiveBookings',
  'maxMinutesPerPeriod',
  'quotaPeriod',
  'participantWithdrawMinMinutes',
  'maxPeople',
  'retentionDays',
] as const satisfies readonly (keyof SpaceSettingsDto & keyof BookingSpace)[];

/** The fields a request may write onto a resource, by name, for the reason above. */
export const RESOURCE_KEYS = [
  'name',
  'description',
  'privateInfo',
  'linkedUserId',
  'position',
] as const satisfies readonly (keyof ResourceDto & keyof BookingResource)[];

/** Copies the `keys` that `source` carries (not `undefined`) onto `target`, and nothing else. */
function copyKeys<K extends string>(
  target: object,
  source: Partial<Record<K, unknown>>,
  keys: readonly K[]
) {
  const into = target as Record<K, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) into[key] = value;
  }
}

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
    private readonly userTags: UserTagService,
    private readonly posterMedia: BookingPosterMedia
  ) {}

  // -- Rights ------------------------------------------------------------------------------------

  /** The space, refused 404 when absent and 403 `not-manager` when the actor does not manage it. */
  private async managedSpace(spaceId: string, actor: Actor): Promise<BookingSpace> {
    const space = await this.spaces.findOneBy({ id: spaceId });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });
    if (!(await mayManageSpace(this.associations, space, actor))) {
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
    if (
      associationId !== null &&
      !(await mayManageSpace(this.associations, { associationId, ownerId: '' }, actor))
    ) {
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
    // Every question its own id: an answer, a condition and the export are keyed by it.
    const ids = items.map((i) => i.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new BadRequestException({ code: 'item-id' });
    }
    const withCondition = items.filter((i) => i.showIf != null);
    if (next.audience == null && withCondition.length === 0) return;
    const tiers = next.associationId
      ? await this.userTags.listCotisationTiers(next.associationId)
      : [];
    const ctx = criteriaContextFor(tiers, items as { id?: string; options?: { id?: string }[] }[]);
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

  /**
   * Copies the settings a DTO carries onto `space` - the names of {@link SPACE_SETTING_KEYS} only,
   * whatever else the body holds; absent keys are left as they are. The poster is copied field by
   * field (`posterOf`).
   */
  private applySettings(space: BookingSpace, dto: SpaceSettingsDto) {
    copyKeys(space, dto, SPACE_SETTING_KEYS);
    const poster = posterOf(dto.poster);
    if (poster !== undefined) space.poster = poster;
    const { opensAt } = dto;
    if (opensAt !== undefined) {
      // The DTO's shape, held here too: an instant without its zone is read in the server's.
      const ms = typeof opensAt === 'string' ? Date.parse(opensAt) : NaN;
      if (opensAt !== null && (!ZONED_INSTANT.test(String(opensAt)) || !Number.isFinite(ms))) {
        throw new BadRequestException({ code: 'opens-at' });
      }
      space.opensAt = opensAt === null ? null : new Date(ms);
    }
    // A slots space carries no step: switching the mode clears it, so the CHECK never sees a mix.
    if (space.slotMode === 'slots') {
      space.stepMinutes = null;
      space.maxSteps = null;
    }
  }

  /**
   * A new space (D2, D16). An entity's space needs `MANAGE_BOOKINGS` on that entity; an entity that
   * does not exist (a global admin naming a stale id) is `association-not-found`, never a 500. A
   * person holds at most {@link MAX_PERSONAL_SPACES} personal spaces, counted under a lock on
   * their id so two creations at once cannot both pass the count.
   */
  async create(dto: CreateSpaceDto, actor: Actor) {
    const associationId = dto.associationId ?? null;
    this.logger.debug(`[BOOKINGS] create space association=${associationId ?? 'personal'}`);
    const owner = { associationId, ownerId: actor.userId };
    if (!(await mayManageSpace(this.associations, owner, actor))) {
      throw new ForbiddenException({ code: 'not-manager' });
    }
    const space = this.spaces.create({ ...owner, slotMode: 'step', stepMinutes: 30, maxSteps: 4 });
    this.applySettings(space, dto);
    await this.assertSettingsValid(space);
    // Parsed before the transaction, so a malformed line refuses the creation as a 400 and nothing
    // is written.
    const hours = dto.availability ? this.parseAvailability(dto.availability) : null;
    // The id is chosen here so the poster can be claimed FOR this space, inside the transaction that
    // stores it: a refused claim refuses the creation, and a rollback leaves the claim to the release.
    space.id = randomUUID();
    const poster = space.poster?.mediaId ?? null;
    let claimed = false;
    try {
      const saved = await this.spaces.manager.transaction(async (m) => {
        if (associationId === null) {
          await m.query(`SELECT pg_advisory_xact_lock(hashtext('booking-personal:' || $1))`, [
            actor.userId,
          ]);
          const held = await m.count(BookingSpace, {
            where: { ownerId: actor.userId, associationId: IsNull() },
          });
          if (held >= MAX_PERSONAL_SPACES) {
            throw new ConflictException({ code: 'too-many-spaces', max: MAX_PERSONAL_SPACES });
          }
        }
        if (poster) {
          await this.posterMedia.claim(m, poster, actor.userId, space.id, associationId);
          claimed = true;
        }
        const created = await m.save(BookingSpace, space);
        const column = await this.writeDefaultColumn(m, created, hours);
        return { id: created.id, resourceId: column };
      });
      this.logger.log(
        `[BOOKINGS] space created id=${saved.id.slice(0, 8)} column=${saved.resourceId.slice(0, 8)} hours=${hours?.lines.length ?? 0}`
      );
      return saved;
    } catch (err) {
      // No row cites the poster this request claimed: it goes back to the idle sweep.
      if (poster && claimed) {
        await this.posterMedia.releaseUncited([poster], 'its space was not created');
      }
      if (isForeignKeyViolation(err)) {
        this.logger.warn(`[BOOKINGS] create refused: association ${associationId} does not exist`);
        throw new NotFoundException({ code: 'association-not-found' });
      }
      throw err;
    }
  }

  /**
   * THE SPACE'S ONE DEFAULT COLUMN (D44): a resource named after the space, at position 0, with the
   * hours the creation carried, if any. The data model is unchanged - a space still books through
   * its resources - so a space that is created bookable needs one; the screens hide the columns
   * level while there is exactly one. Written inside the creation's transaction: a refused write
   * leaves no space without its column.
   */
  private async writeDefaultColumn(
    m: EntityManager,
    space: BookingSpace,
    hours: { lines: AvailabilityLine[]; exceptions: AvailabilityException[] } | null
  ): Promise<string> {
    const column = await m.save(
      BookingResource,
      m.create(BookingResource, { spaceId: space.id, name: space.name, position: 0 })
    );
    if (hours?.lines.length) {
      await m.insert(
        BookingAvailabilityRule,
        hours.lines.map((l) => ({ ...l, resourceId: column.id }))
      );
    }
    if (hours?.exceptions.length) {
      await m.insert(
        BookingAvailabilityException,
        hours.exceptions.map((e) => ({ ...e, resourceId: column.id }))
      );
    }
    this.logger.debug(
      `[BOOKINGS] default column written space=${space.id.slice(0, 8)} lines=${hours?.lines.length ?? 0} closures=${hours?.exceptions.length ?? 0}`
    );
    return column.id;
  }

  /**
   * Changes settings (D35). A change of zone, mode, step or step ceiling is a change of what is
   * bookable, so it is checked against every resource's coming bookings first (D29), under the
   * space lock. A new poster is CLAIMED at the media service inside the same transaction, after
   * every check; the one it replaces is released once the change is committed, if no other space
   * cites it (`BookingPosterMedia`).
   */
  async update(spaceId: string, dto: SpaceSettingsDto, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] update space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    let claimed: string | null = null;
    try {
      const { oldPoster, newPoster } = await this.spaces.manager.transaction(async (m) => {
        const space = await this.lockSpace(m, spaceId);
        const oldPoster = space.poster?.mediaId ?? null;
        const before: SlotConfig = { ...space };
        const formerName = space.name;
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
        // Compared under the space lock, so two saves of one space cannot both believe they change
        // the poster; re-sending the poster already there claims nothing.
        const newPoster = space.poster?.mediaId ?? null;
        if (newPoster && newPoster !== oldPoster) {
          await this.posterMedia.claim(m, newPoster, actor.userId, spaceId, space.associationId);
          claimed = newPoster;
        }
        await m.save(BookingSpace, space);
        if (space.name !== formerName)
          await this.renameDefaultColumn(m, spaceId, formerName, space.name);
        this.logger.log(`[BOOKINGS] space updated id=${spaceId.slice(0, 8)}`);
        return { oldPoster, newPoster };
      });
      if (oldPoster && newPoster !== oldPoster) {
        await this.posterMedia.releaseUncited([oldPoster], 'replaced or removed');
      }
      return { ok: true };
    } catch (err) {
      // The row does not cite the poster this request claimed: back to the idle sweep.
      if (claimed) await this.posterMedia.releaseUncited([claimed], 'its update was refused');
      throw err;
    }
  }

  /**
   * A renamed space carries its HIDDEN column's name along (D44): the column is the space's only
   * resource and still bears the space's former name, which is how it was created. A space's only
   * column that the organiser named otherwise keeps its own name, and so does any column once there
   * are two. Without this, the name a booker reads in their bookings, the calendar file and the
   * export would stay the old one. Runs under the space lock the update holds.
   */
  private async renameDefaultColumn(
    m: EntityManager,
    spaceId: string,
    formerName: string,
    name: string
  ): Promise<void> {
    // A CTE, so the statement answers rows whatever the driver makes of a bare UPDATE.
    const [{ n }]: { n: number }[] = await m.query(
      `WITH renamed AS (
         UPDATE booking_resources SET name = $3
          -- The former name IS the discriminator: the hidden column is the one bearing its space's
          -- name (D44, the client's columnsHidden), so a column the organiser named never matches.
          WHERE "spaceId" = $1 AND name = $2
            AND (SELECT count(*) FROM booking_resources WHERE "spaceId" = $1) = 1
         RETURNING id)
       SELECT count(*)::int AS n FROM renamed`,
      [spaceId, formerName, name]
    );
    this.logger.debug(
      `[BOOKINGS] space renamed id=${spaceId.slice(0, 8)} hiddenColumnFollowed=${n === 1}`
    );
  }

  /**
   * Deletes the space and EVERYTHING under it, history included (D27) - other people's COMING
   * bookings too, hard-deleted with no notice (D13: no notification in v1). How many is logged, so
   * a deletion that erased someone's evening is never silent in the logs.
   */
  async remove(spaceId: string, actor: Actor, nowMs: number) {
    this.logger.debug(`[BOOKINGS] remove space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    const { erased, poster } = await this.spaces.manager.transaction(async (m) => {
      const space = await this.lockSpace(m, spaceId);
      const [{ n }]: { n: number }[] = await m.query(
        `SELECT count(*)::int AS n FROM bookings b JOIN booking_resources r ON r.id = b."resourceId"
          WHERE r."spaceId" = $1 AND b."cancelledAt" IS NULL AND b."startsAt" > $2
            AND b."holderId" <> $3`,
        [spaceId, new Date(nowMs), actor.userId]
      );
      await m.delete(BookingSpace, { id: spaceId });
      return { erased: n, poster: space.poster?.mediaId ?? null };
    });
    this.logger.log(
      `[BOOKINGS] space deleted id=${spaceId.slice(0, 8)} comingBookingsOfOthersErased=${erased}`
    );
    // Its files (D7) are now orphans (`booking_files."bookingId"` set NULL): the retention purge
    // takes them at its next run.
    if (poster) await this.posterMedia.releaseUncited([poster], 'its space was deleted');
    return { ok: true };
  }

  // -- Resources ---------------------------------------------------------------------------------

  /** Refuses a linked account that does not exist (D10). */
  private async assertAccount(m: EntityManager, userId: string | null | undefined) {
    if (!userId) return;
    const rows: unknown[] = await m.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (rows.length === 0) throw new BadRequestException({ code: 'unknown-account' });
  }

  /** The resource fields of a request, by name ({@link RESOURCE_KEYS}), the link normalised. */
  private resourceFields(dto: ResourceDto): Partial<BookingResource> {
    const fields: Partial<BookingResource> = {};
    copyKeys(fields, dto, RESOURCE_KEYS);
    if (typeof fields.linkedUserId === 'string') {
      fields.linkedUserId = fields.linkedUserId.trim().toLowerCase() || null;
    }
    return fields;
  }

  /**
   * A new resource. At most {@link MAX_RESOURCES_PER_SPACE} per space, counted under the space
   * lock so two additions at once cannot both pass the count.
   */
  async addResource(spaceId: string, dto: CreateResourceDto, actor: Actor) {
    this.logger.debug(`[BOOKINGS] addResource space=${spaceId}`);
    await this.managedSpace(spaceId, actor);
    const fields = this.resourceFields(dto);
    return this.spaces.manager.transaction(async (m) => {
      await this.lockSpace(m, spaceId);
      await this.assertAccount(m, fields.linkedUserId);
      if ((await m.count(BookingResource, { where: { spaceId } })) >= MAX_RESOURCES_PER_SPACE) {
        throw new ConflictException({ code: 'too-many-resources', max: MAX_RESOURCES_PER_SPACE });
      }
      const saved = await m.save(
        BookingResource,
        m.create(BookingResource, { ...fields, spaceId })
      );
      this.logger.log(`[BOOKINGS] resource added id=${saved.id.slice(0, 8)}`);
      return { id: saved.id };
    });
  }

  async updateResource(resourceId: string, dto: ResourceDto, actor: Actor) {
    this.logger.debug(`[BOOKINGS] updateResource resource=${resourceId}`);
    const { resource } = await this.managedResource(resourceId, actor);
    const fields = this.resourceFields(dto);
    await this.assertAccount(this.resources.manager, fields.linkedUserId);
    Object.assign(resource, fields);
    await this.resources.save(resource);
    return { ok: true };
  }

  /**
   * Deletes a resource that has NEVER BEEN BOOKED (D42, review of #2006). A booking - past,
   * coming or cancelled - is history, and history is frozen while its space exists (D15): only
   * deleting the SPACE erases it (D27). So a resource with any booking is refused
   * `resource-has-bookings`; the organiser closes it instead (its availability, or a closure).
   * Checked under the space lock, so no booking lands between the check and the delete.
   */
  async removeResource(resourceId: string, actor: Actor) {
    this.logger.debug(`[BOOKINGS] removeResource resource=${resourceId}`);
    const { space } = await this.managedResource(resourceId, actor);
    return this.spaces.manager.transaction(async (m) => {
      await this.lockSpace(m, space.id);
      const booked = await m.count(Booking, { where: { resourceId } });
      if (booked > 0) {
        this.logger.debug(`[BOOKINGS] removeResource refused: ${booked} booking(s) of history`);
        throw new ConflictException({ code: 'resource-has-bookings' });
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
