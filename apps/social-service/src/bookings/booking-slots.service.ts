import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import {
  type AvailabilityException,
  type AvailabilityLine,
  type SlotConfig,
  type UnitState,
  type Window,
  availabilityWindows,
  bookingsOutsideAvailability,
  slotUnits,
  unitStates,
} from './slots';
import { addDays, datesBetween, zonedToUtcMs } from './zoned-time';

/** The widest range of local dates one read may ask for: a grid shows a week, a planning a month. */
export const MAX_SLOT_RANGE_DAYS = 62;

/** One bookable unit of a resource and what it is now. Names are not here: visibility is WP-B3's. */
export type SlotView = Window & UnitState;

/** A resource and its units over the dates asked. */
export interface ResourceSlots {
  resourceId: string;
  units: SlotView[];
}

/** The refusal of an availability change (D29), as a code and the bookings it names. */
export const BOOKINGS_INSIDE_CHANGE = 'bookings-inside-change';

/**
 * Slot generation ON DEMAND for a space (D11) and the D29 guard, over the tables of migration 087.
 * The arithmetic is in `slots.ts`; this reads what it needs and nothing else. Rights and the
 * visibility of names are the API's (WP-B3): nothing here is a route.
 */
@Injectable()
export class BookingSlotsService {
  private readonly logger = new Logger(BookingSlotsService.name);

  constructor(
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>,
    @InjectRepository(BookingResource) private readonly resources: Repository<BookingResource>,
    @InjectRepository(BookingAvailabilityRule)
    private readonly rules: Repository<BookingAvailabilityRule>,
    @InjectRepository(BookingAvailabilityException)
    private readonly exceptions: Repository<BookingAvailabilityException>,
    @InjectRepository(BookingBlock) private readonly blocks: Repository<BookingBlock>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>
  ) {}

  /**
   * Every unit of every resource of the space whose local start date is in `[from, to]`, with its
   * state (free, booked by a LIVE booking, blocked). Refuses a reversed range or one wider than
   * {@link MAX_SLOT_RANGE_DAYS}.
   */
  async spaceSlots(spaceId: string, from: string, to: string): Promise<ResourceSlots[]> {
    this.logger.debug(`[BOOKINGS] spaceSlots space=${spaceId} ${from}..${to}`);
    const days = datesBetween(from, to).length;
    if (days === 0 || days > MAX_SLOT_RANGE_DAYS) {
      this.logger.warn(`[BOOKINGS] spaceSlots refused: ${days} days asked`);
      throw new BadRequestException({ code: 'slot-range', maxDays: MAX_SLOT_RANGE_DAYS });
    }
    const space = await this.spaces.findOneBy({ id: spaceId });
    if (!space) throw new NotFoundException({ code: 'space-not-found' });

    const resources = await this.resources.find({
      where: { spaceId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    if (resources.length === 0) return [];
    const ids = resources.map((r) => r.id);

    // Generous UTC bounds: a window may start on `to` and cross midnight into the day after.
    const startMs = zonedToUtcMs(addDays(from, -1), '00:00', space.timeZone);
    const endMs = zonedToUtcMs(addDays(to, 3), '00:00', space.timeZone);
    const inRange = {
      resourceId: In(ids),
      startsAt: LessThan(new Date(endMs)),
      endsAt: MoreThan(new Date(startMs)),
    };
    const [rules, exceptions, live, blocks] = await Promise.all([
      this.rules.find({ where: { resourceId: In(ids) } }),
      this.exceptions.find({ where: { resourceId: In(ids) } }),
      this.bookings.find({ where: { ...inRange, cancelledAt: IsNull() } }),
      this.blocks.find({ where: inRange }),
    ]);

    return resources.map((r) => {
      const windows = availabilityWindows(
        space,
        rules.filter((l) => l.resourceId === r.id),
        exceptions.filter((e) => e.resourceId === r.id),
        from,
        to
      );
      const units = slotUnits(space, windows);
      const states = unitStates(
        units,
        live.filter((b) => b.resourceId === r.id).map(occupation),
        blocks.filter((b) => b.resourceId === r.id).map(occupation)
      );
      return { resourceId: r.id, units: units.map((u, i) => ({ ...u, ...states[i] })) };
    });
  }

  /**
   * D29: refuses an availability change of ONE resource while coming live bookings would fall
   * outside it, naming them (409, code {@link BOOKINGS_INSIDE_CHANGE}). `config` is the space's
   * settings AFTER the change (a new step or mode counts), `lines` and `exceptions` the resource's
   * whole new availability. Blocking a free range is not a change of availability (D29).
   */
  async assertAvailabilityChangeAllowed(
    resourceId: string,
    config: SlotConfig,
    lines: readonly AvailabilityLine[],
    exceptions: readonly AvailabilityException[],
    nowMs: number
  ): Promise<void> {
    this.logger.debug(`[BOOKINGS] availability change check resource=${resourceId}`);
    const coming = await this.bookings.find({
      where: { resourceId, cancelledAt: IsNull(), startsAt: MoreThan(new Date(nowMs)) },
      order: { startsAt: 'ASC' },
    });
    const outside = bookingsOutsideAvailability(
      config,
      lines,
      exceptions,
      coming.map((b) => ({ ...occupation(b), booking: b }))
    );
    if (outside.length > 0) {
      this.logger.log(
        `[BOOKINGS] availability change refused resource=${resourceId} bookings=${outside.length}`
      );
      throw new ConflictException({
        code: BOOKINGS_INSIDE_CHANGE,
        bookingIds: outside.map((o) => o.id),
      });
    }
  }
}

/** A booking or a block as a range with its id. */
function occupation(row: { id: string; startsAt: Date; endsAt: Date }) {
  return { id: row.id, startMs: row.startsAt.getTime(), endMs: row.endsAt.getTime() };
}
