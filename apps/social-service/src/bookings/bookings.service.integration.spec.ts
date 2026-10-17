/**
 * THE BOOKINGS API'S RULES AGAINST A REAL POSTGRESQL (WP-B3).
 *
 * `BookingsService` is run on a real connection, with migrations 087 onwards applied to a throwaway
 * schema, because what it promises is a database's to keep: the space-then-resource row locks that
 * turn every losing racer into a typed `slot-taken` (never a deadlock), quotas that hold across the
 * resources of one space, a block refused over live bookings. Rights to an association
 * (`AssociationsService.mayAct`) and the audience facts are stubbed: they have their own specs, and
 * what is under test here is how the API USES them.
 *
 * Time is never the wall clock: every call is handed `NOW`, and the fixtures sit around it.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (see `bookings.integration.spec.ts`).
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { BOOKING_ENTITIES } from './bookings.module';
import { BookingsService, type Actor } from './bookings.service';
import { BookingSlotsService } from './booking-slots.service';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { Association } from '../associations/entities/association.entity';
import type { AssociationsService } from '../associations/associations.service';
import type { PricingFactsService } from '../pricing/pricing-facts.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_DIR = join(__dirname, '..', 'migrations');
const MIGRATION = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d+_booking/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIGRATION_DIR, f), 'utf8'))
  .join('\n');

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);
const DAN = 'd'.repeat(64);
/** The organiser of association spaces (MANAGE_BOOKINGS, stubbed). */
const ORGA = 'e'.repeat(64);
const STRANGER = 'f'.repeat(64);
/** Created association spaces; holds no right on the association, so manages nothing. */
const CREATOR = 'cr'.repeat(32);
/** The eight racers of the lock test. */
const RACERS = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(64));

/** Sunday 2026-11-01 12:00 UTC; the space is in UTC so local times read as written. */
const NOW = Date.parse('2026-11-01T12:00:00Z');
const on = (hhmm: string, day = '2026-11-02') => `${day}T${hhmm}:00.000Z`;

const as = (userId: string): Actor => ({ userId, isGlobalAdmin: false });

/** The `code` of the typed refusal a call ends in - never its message. */
async function refusal(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return err.getResponse() as Record<string, unknown>;
    throw err;
  }
  throw new Error('expected a refusal, the call succeeded');
}

maybe('BookingsService against PostgreSQL (WP-B3)', () => {
  const schema = `bookings_api_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: BookingsService;
  let slotsService: BookingSlotsService;
  /** `account:association` pairs holding MANAGE_BOOKINGS. */
  const grants = new Set<string>();
  /** The audience facts of an account, as `PricingFactsService` would build them. */
  const facts = new Map<string, Record<string, unknown>>();
  /** Runs while the facts are built - i.e. between `book`'s first read of the space and its lock. */
  let duringFacts: (() => Promise<void>) | null = null;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...BOOKING_ENTITIES, Association],
      synchronize: false,
      extra: { options: `-c search_path=${schema}`, max: 12 },
    });
    await ds.initialize();
    // The tables of other owners the API reads, in the shape it reads them.
    await q(`CREATE TABLE associations (id uuid PRIMARY KEY)`);
    await q(`CREATE TABLE users (id varchar PRIMARY KEY, "firstName" varchar, "lastName" varchar)`);
    await q(
      `CREATE TABLE user_blocks ("blockerId" varchar NOT NULL, "blockedId" varchar NOT NULL)`
    );
    await q(MIGRATION);
    for (const [id, first] of [
      [ALICE, 'Alice'],
      [BOB, 'Bob'],
      [CAROL, 'Carol'],
      [DAN, 'Dan'],
      [ORGA, 'Orga'],
      [STRANGER, 'Stranger'],
      ...RACERS.map((r, i) => [r, `Racer${i}`]),
    ]) {
      await q(`INSERT INTO users (id, "firstName", "lastName") VALUES ($1, $2, 'X')`, [id, first]);
    }

    // The right as the real policy grants it: per account, per association, per flag. A stub that
    // answered on the account alone would let "ownerId grants nothing" and "the organiser of A on
    // B's space" pass whatever the service did.
    const associations = {
      mayAct: async (userId: string, associationId: string, flag: number) =>
        flag === AssociationPermissionFlag.MANAGE_BOOKINGS &&
        grants.has(`${userId}:${associationId}`),
    } as unknown as AssociationsService;
    const pricingFacts = {
      build: async ({ userId }: { userId: string }) => {
        await duringFacts?.();
        return facts.get(userId) ?? {};
      },
    } as unknown as PricingFactsService;
    const repo = <T extends object>(e: new () => T) => ds.getRepository(e);
    service = new BookingsService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(Booking),
      repo(BookingParticipant),
      repo(BookingBlock),
      (slotsService = new BookingSlotsService(
        repo(BookingSpace),
        repo(BookingResource),
        repo(BookingAvailabilityRule),
        repo(BookingAvailabilityException),
        repo(BookingBlock),
        repo(Booking)
      )),
      associations,
      pricingFacts
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /**
   * An association space, in UTC, steps of 30 min up to 4, open 08:00-22:00 every day, with
   * `resources` resources. CREATED by CREATOR, who holds no right on the association; MANAGED by
   * ORGA, who holds MANAGE_BOOKINGS on it - unless `managed` is false.
   */
  async function setup(settings: Partial<BookingSpace> = {}, resources = 1, managed = true) {
    const association = (
      await q(`INSERT INTO associations (id) VALUES (gen_random_uuid()) RETURNING id`)
    )[0].id as string;
    if (managed) grants.add(`${ORGA}:${association}`);
    const space = await ds.getRepository(BookingSpace).save({
      ownerId: CREATOR,
      associationId: association,
      name: 'Salle de musique',
      timeZone: 'UTC',
      stepMinutes: 30,
      maxSteps: 4,
      privateInfo: 'code 1234',
      ...settings,
    });
    const ids: string[] = [];
    for (let i = 0; i < resources; i++) {
      const r = await ds
        .getRepository(BookingResource)
        .save({ spaceId: space.id, name: `Salle ${i}`, privateInfo: `cle ${i}`, position: i });
      for (let weekday = 1; weekday <= 7; weekday++) {
        await q(
          `INSERT INTO booking_availability_rules ("resourceId", weekday, "startTime", "endTime")
           VALUES ($1, $2, '08:00', '22:00')`,
          [r.id, weekday]
        );
      }
      ids.push(r.id);
    }
    return { space, resourceIds: ids };
  }

  const book = (
    spaceId: string,
    resourceId: string,
    from: string,
    to: string,
    actor = ALICE,
    extra: { participantIds?: string[]; holderId?: string } = {},
    nowMs = NOW
  ) =>
    service.book(
      spaceId,
      { resourceId, startsAt: on(from), endsAt: on(to), ...extra },
      as(actor),
      nowMs
    );

  describe('the lock', () => {
    it('eight simultaneous bookings of one slot: one wins, EVERY loser is told slot-taken', async () => {
      for (let round = 0; round < 5; round++) {
        const { space, resourceIds } = await setup();
        const outcomes = await Promise.allSettled(
          RACERS.map((r) => book(space.id, resourceIds[0], '14:00', '14:30', r))
        );
        const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect(outcomes.length - lost.length).toBe(1);
        expect(
          lost.map((o) => (o.reason as HttpException).getResponse() as { code: string })
        ).toEqual(Array(7).fill({ code: 'slot-taken' }));
      }
    }, 60_000);

    it('holds a quota ACROSS resources: two concurrent bookings of one person, one passes', async () => {
      const { space, resourceIds } = await setup({ maxActiveBookings: 1 }, 2);
      const outcomes = await Promise.allSettled([
        book(space.id, resourceIds[0], '10:00', '10:30'),
        book(space.id, resourceIds[1], '10:00', '10:30'),
      ]);
      const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(lost).toHaveLength(1);
      expect((lost[0].reason as HttpException).getResponse()).toEqual({
        code: 'active-bookings',
        holder: true,
      });
    });
  });

  describe('booking', () => {
    it('counts a participant against their own quota, and an organiser on behalf is exempt', async () => {
      const { space, resourceIds } = await setup({ maxActiveBookings: 1 }, 2);
      await book(space.id, resourceIds[0], '10:00', '10:30', BOB);
      expect(
        await refusal(
          book(space.id, resourceIds[1], '11:00', '11:30', ALICE, { participantIds: [BOB] })
        )
      ).toEqual({ code: 'active-bookings', holder: false });
      await expect(
        book(space.id, resourceIds[1], '11:00', '11:30', ORGA, { holderId: BOB })
      ).resolves.toHaveProperty('id');
    });

    it('lets only the organiser book on behalf', async () => {
      const { space, resourceIds } = await setup();
      expect(
        await refusal(book(space.id, resourceIds[0], '10:00', '10:30', ALICE, { holderId: BOB }))
      ).toEqual({ code: 'not-manager' });
    });

    it('refuses a past slot, a misaligned range, an unknown account and a blocked pair', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      expect(
        await refusal(book(space.id, r, '10:00', '10:30', ALICE, {}, Date.parse(on('10:10'))))
      ).toEqual({
        code: 'started',
      });
      expect(await refusal(book(space.id, r, '10:10', '10:40'))).toEqual({ code: 'misaligned' });
      expect(
        await refusal(
          book(space.id, r, '10:00', '10:30', ALICE, { participantIds: ['9'.repeat(64)] })
        )
      ).toEqual({ code: 'unknown-account' });
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [CAROL, ALICE]);
      // Symmetric: CAROL blocked ALICE, and ALICE may not add CAROL either.
      expect(
        await refusal(book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [CAROL] }))
      ).toEqual({ code: 'participant-blocked' });
    });
  });

  describe('cancelling and withdrawing (D5, decided by the user 2026-10-17)', () => {
    it('the holder cancels five minutes before the start, whatever the participants delay', async () => {
      const { space, resourceIds } = await setup({ participantWithdrawMinMinutes: 120 });
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      const late = Date.parse(on('09:55'));
      expect(await refusal(service.withdraw(id, as(BOB), late))).toEqual({
        code: 'withdrawal-delay',
      });
      expect(await refusal(service.cancel(id, as(STRANGER), late))).toEqual({ code: 'not-yours' });
      await expect(service.cancel(id, as(ALICE), late)).resolves.toEqual({ ok: true });
      expect(await refusal(service.cancel(id, as(ALICE), late))).toEqual({
        code: 'already-cancelled',
      });
    });

    it('the organiser cancels at any time; a participant withdraws before the delay', async () => {
      const { space, resourceIds } = await setup({ participantWithdrawMinMinutes: 120 });
      const first = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      await expect(service.cancel(first.id, as(ORGA), Date.parse(on('09:59')))).resolves.toEqual({
        ok: true,
      });

      const second = await book(space.id, resourceIds[0], '12:00', '12:30', ALICE, {
        participantIds: [BOB],
      });
      // 12:00 minus 120 min: 10:00 is already too late, 09:59 is not.
      expect(await refusal(service.withdraw(second.id, as(BOB), Date.parse(on('10:00'))))).toEqual({
        code: 'withdrawal-delay',
      });
      await expect(service.withdraw(second.id, as(BOB), Date.parse(on('09:59')))).resolves.toEqual({
        ok: true,
      });
      expect(await refusal(service.withdraw(second.id, as(BOB), NOW))).toEqual({
        code: 'not-a-participant',
      });
    });

    it('with no delay a participant withdraws until the start', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      await expect(service.withdraw(id, as(BOB), Date.parse(on('09:59')))).resolves.toEqual({
        ok: true,
      });
    });

    it('nothing moves once a booking has started: it is history', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      const started = Date.parse(on('10:00'));
      expect(await refusal(service.cancel(id, as(ALICE), started))).toEqual({
        code: 'history-frozen',
      });
      expect(await refusal(service.cancel(id, as(ORGA), started))).toEqual({
        code: 'history-frozen',
      });
      expect(await refusal(service.withdraw(id, as(BOB), started))).toEqual({
        code: 'history-frozen',
      });
    });
  });

  describe('blocks (D10, D29)', () => {
    it('refuses a block over a live booking, naming it, then takes it once cancelled', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      const { id } = await book(space.id, r, '10:00', '10:30');
      const block = { startsAt: on('09:00'), endsAt: on('12:00'), reason: 'travaux' };
      expect(await refusal(service.addBlock(r, block, as(ORGA), NOW))).toEqual({
        code: 'bookings-inside-block',
        bookingIds: [id],
      });
      expect(await refusal(service.addBlock(r, block, as(ALICE), NOW))).toEqual({
        code: 'not-manager',
      });
      await service.cancel(id, as(ALICE), NOW);
      const { id: blockId } = await service.addBlock(r, block, as(ORGA), NOW);
      expect(await refusal(book(space.id, r, '10:00', '10:30'))).toEqual({ code: 'blocked' });
      await service.removeBlock(blockId, as(ORGA), NOW);
      await expect(book(space.id, r, '10:00', '10:30')).resolves.toHaveProperty('id');
    });

    it('lets the linked account block its own resource, and refuses a past range', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await ds.getRepository(BookingResource).update(r, { linkedUserId: DAN });
      expect(
        await refusal(
          service.addBlock(
            r,
            { startsAt: on('08:00', '2026-10-01'), endsAt: on('09:00', '2026-10-01') },
            as(DAN),
            NOW
          )
        )
      ).toEqual({ code: 'history-frozen' });
      await expect(
        service.addBlock(r, { startsAt: on('08:00'), endsAt: on('09:00') }, as(DAN), NOW)
      ).resolves.toHaveProperty('id');
      expect(await refusal(service.removeBlock(randomUUID(), as(DAN), NOW))).toEqual({
        code: 'block-not-found',
      });
      expect(space.slotMode).toBe('step');
    });
  });

  describe('what each viewer reads (D9, D32)', () => {
    async function bookedUnit(spaceId: string, viewer: string) {
      const grid = await service.spaceSlots(spaceId, '2026-11-02', '2026-11-02', as(viewer));
      return grid[0].units.find((u) => u.state === 'booked')!;
    }

    it("'occupied': a stranger reads no name, the people and the organiser read them", async () => {
      const { space, resourceIds } = await setup({ nameVisibility: 'occupied' });
      await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, { participantIds: [BOB] });

      const stranger = await bookedUnit(space.id, STRANGER);
      expect(stranger.booking).not.toHaveProperty('holderName');
      expect(stranger.booking).not.toHaveProperty('participantNames');
      expect(stranger.booking).not.toHaveProperty('answers');
      expect(stranger.booking?.mine).toBe(false);

      const bob = await bookedUnit(space.id, BOB);
      expect(bob.booking).toMatchObject({
        holderName: 'Alice X',
        participantNames: ['Bob X'],
        mine: true,
      });
      expect(bob.booking).not.toHaveProperty('answers');

      expect(await bookedUnit(space.id, ORGA)).toHaveProperty('booking.answers');
    });

    it("'names': a stranger reads the names, never the answers", async () => {
      const { space, resourceIds } = await setup({ nameVisibility: 'names' });
      await book(space.id, resourceIds[0], '10:00', '10:30', ALICE);
      const stranger = await bookedUnit(space.id, STRANGER);
      expect(stranger.booking).toMatchObject({ holderName: 'Alice X' });
      expect(stranger.booking).not.toHaveProperty('answers');
    });

    it('private texts reach the people of a LIVE booking only', async () => {
      const { space, resourceIds } = await setup();
      const live = await book(space.id, resourceIds[0], '10:00', '10:30', CAROL, {
        participantIds: [DAN],
      });
      const gone = await book(space.id, resourceIds[0], '11:00', '11:30', CAROL);
      await service.cancel(gone.id, as(CAROL), NOW);

      const mine = await service.mine(as(DAN));
      expect(mine.find((b) => b.id === live.id)?.privateInfo).toEqual({
        spacePrivateInfo: 'code 1234',
        resourcePrivateInfo: 'cle 0',
      });
      const carol = await service.mine(as(CAROL));
      expect(carol.find((b) => b.id === gone.id)?.privateInfo).toBeNull();
      expect(await service.mine(as(STRANGER))).toEqual([]);
      expect(await service.getSpace(space.id, as(STRANGER))).not.toHaveProperty('privateInfo');
    });

    it('the organiser list is the organiser alone', async () => {
      const { space } = await setup();
      expect(await refusal(service.spaceBookings(space.id, as(ALICE)))).toEqual({
        code: 'not-manager',
      });
      await expect(service.spaceBookings(space.id, as(ORGA))).resolves.toEqual({
        items: [],
        nextOffset: null,
      });
    });

    it('pages the organiser list by start', async () => {
      const { space, resourceIds } = await setup();
      const ids = [];
      for (const [from, to] of [
        ['10:00', '10:30'],
        ['11:00', '11:30'],
        ['12:00', '12:30'],
      ]) {
        ids.push((await book(space.id, resourceIds[0], from, to)).id);
      }
      const first = await service.spaceBookings(space.id, as(ORGA), 0, 2);
      expect(first.items.map((b) => b.id)).toEqual(ids.slice(0, 2));
      expect(first.nextOffset).toBe(2);
      const last = await service.spaceBookings(space.id, as(ORGA), 2, 2);
      expect(last.items.map((b) => b.id)).toEqual([ids[2]]);
      expect(last.nextOffset).toBeNull();
    });

    it('the account linked to a resource reads its bookings (D10): names, never answers', async () => {
      const { space, resourceIds } = await setup({ nameVisibility: 'occupied' });
      await ds.getRepository(BookingResource).update(resourceIds[0], { linkedUserId: DAN });
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE);

      const unit = await bookedUnit(space.id, DAN);
      expect(unit.booking).toMatchObject({ holderName: 'Alice X', mine: false });
      expect(unit.booking).not.toHaveProperty('answers');

      // Other tests booked for DAN too: this booking is read by its id.
      const dans = (await service.mine(as(DAN))).filter((b) => b.id === id);
      expect(dans).toEqual([
        expect.objectContaining({ linked: true, holder: false, holderName: 'Alice X' }),
      ]);
      expect(dans[0]).not.toHaveProperty('answers');
      expect(dans[0].privateInfo).toEqual({
        spacePrivateInfo: 'code 1234',
        resourcePrivateInfo: 'cle 0',
      });
    });

    it('a participant who withdrew reads an occupied space as anyone else does', async () => {
      const { space, resourceIds } = await setup({ nameVisibility: 'occupied' });
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      await service.withdraw(id, as(BOB), NOW);
      expect((await bookedUnit(space.id, BOB)).booking).not.toHaveProperty('holderName');
      const bobs = (await service.mine(as(BOB))).filter((b) => b.id === id);
      expect(bobs).toEqual([expect.objectContaining({ withdrawn: true })]);
      expect(bobs[0]).not.toHaveProperty('holderName');
      expect(bobs[0].privateInfo).toBeNull();
    });

    it('leaves out a booking that vanished between the two reads, never a 500', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30');
      const real = slotsService.spaceSlots.bind(slotsService);
      const spy = jest.spyOn(slotsService, 'spaceSlots').mockImplementationOnce(async (...args) => {
        const grid = await real(...args);
        await q(`DELETE FROM bookings WHERE id = $1`, [id]);
        return grid;
      });
      try {
        const grid = await service.spaceSlots(space.id, '2026-11-02', '2026-11-02', as(ALICE));
        expect(grid[0].units.some((u) => u.state === 'booked')).toBe(false);
        expect(grid[0].units.length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('review of #2002: rights before state, blocks and the past', () => {
    it('tells a stranger not-yours whatever the state of the booking', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      await service.cancel(id, as(ALICE), NOW);
      expect(await refusal(service.cancel(id, as(STRANGER), NOW))).toEqual({ code: 'not-yours' });
      expect(await refusal(service.withdraw(id, as(STRANGER), NOW))).toEqual({
        code: 'not-a-participant',
      });
      const started = Date.parse(on('10:10'));
      expect(await refusal(service.cancel(id, as(STRANGER), started))).toEqual({
        code: 'not-yours',
      });
    });

    it("lets a linked account lift its own blocks only, never the organiser's", async () => {
      const { resourceIds } = await setup();
      const r = resourceIds[0];
      await ds.getRepository(BookingResource).update(r, { linkedUserId: DAN });
      const orgas = await service.addBlock(
        r,
        { startsAt: on('09:00'), endsAt: on('10:00') },
        as(ORGA),
        NOW
      );
      const dans = await service.addBlock(
        r,
        { startsAt: on('14:00'), endsAt: on('15:00') },
        as(DAN),
        NOW
      );
      expect(await refusal(service.removeBlock(orgas.id, as(DAN), NOW))).toEqual({
        code: 'not-yours',
      });
      await expect(service.removeBlock(dans.id, as(DAN), NOW)).resolves.toEqual({ ok: true });
      await expect(service.removeBlock(orgas.id, as(ORGA), NOW)).resolves.toEqual({ ok: true });
    });

    it('refuses a block starting in the past; a booking under way neither refuses nor is named', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await book(space.id, r, '10:00', '10:30');
      const coming = await book(space.id, r, '11:00', '11:30');
      const at1015 = Date.parse(on('10:15'));
      expect(
        await refusal(
          service.addBlock(r, { startsAt: on('10:00'), endsAt: on('12:00') }, as(ORGA), at1015)
        )
      ).toEqual({ code: 'history-frozen' });
      expect(
        await refusal(
          service.addBlock(r, { startsAt: on('10:15'), endsAt: on('12:00') }, as(ORGA), at1015)
        )
      ).toEqual({ code: 'bookings-inside-block', bookingIds: [coming.id] });
      await service.cancel(coming.id, as(ALICE), at1015);
      await expect(
        service.addBlock(r, { startsAt: on('10:15'), endsAt: on('12:00') }, as(ORGA), at1015)
      ).resolves.toHaveProperty('id');
    });

    it('lifting a block under way ends it now and keeps its past part', async () => {
      const { resourceIds } = await setup();
      const { id } = await service.addBlock(
        resourceIds[0],
        { startsAt: on('10:00'), endsAt: on('12:00') },
        as(ORGA),
        NOW
      );
      const at11 = Date.parse(on('11:00'));
      await service.removeBlock(id, as(ORGA), at11);
      const row = await ds.getRepository(BookingBlock).findOneByOrFail({ id });
      expect([row.startsAt.toISOString(), row.endsAt.toISOString()]).toEqual([
        on('10:00'),
        on('11:00'),
      ]);
      expect(await refusal(service.removeBlock(id, as(ORGA), at11))).toEqual({
        code: 'history-frozen',
      });
    });
  });

  describe('review of #2002: rights read as the real policy grants them', () => {
    it('the CREATOR of an association space manages nothing: ownerId grants no right', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE);
      expect(await refusal(service.spaceBookings(space.id, as(CREATOR)))).toEqual({
        code: 'not-manager',
      });
      expect(await refusal(service.cancel(id, as(CREATOR), NOW))).toEqual({ code: 'not-yours' });
      expect(
        await refusal(book(space.id, resourceIds[0], '11:00', '11:30', CREATOR, { holderId: BOB }))
      ).toEqual({ code: 'not-manager' });
    });

    it("the organiser of association A has no right on B's space", async () => {
      await setup();
      const b = await setup({}, 1, false);
      expect(await refusal(service.spaceBookings(b.space.id, as(ORGA)))).toEqual({
        code: 'not-manager',
      });
      expect(
        await refusal(book(b.space.id, b.resourceIds[0], '10:00', '10:30', ORGA, { holderId: BOB }))
      ).toEqual({ code: 'not-manager' });
    });

    it('refuses a resource of another space', async () => {
      const a = await setup();
      const b = await setup();
      expect(await refusal(book(a.space.id, b.resourceIds[0], '10:00', '10:30'))).toEqual({
        code: 'resource-not-found',
      });
    });

    it('refuses an account outside the audience, on every read and write', async () => {
      const { space, resourceIds } = await setup({ audience: { promo: { values: [2024] } } });
      facts.set(BOB, { promo: 2024, formation: null, cotisationTiers: [], answers: {} });
      for (const p of [
        service.getSpace(space.id, as(ALICE)),
        service.spaceSlots(space.id, '2026-11-02', '2026-11-02', as(ALICE)),
        book(space.id, resourceIds[0], '10:00', '10:30', ALICE),
      ]) {
        expect(await refusal(p)).toEqual({ code: 'audience' });
      }
      await expect(book(space.id, resourceIds[0], '10:00', '10:30', BOB)).resolves.toHaveProperty(
        'id'
      );
    });

    it('decides on the space AS LOCKED: a ceiling or the questions changed meanwhile count', async () => {
      const items = [{ id: 'q', label: 'Promo', required: false, type: 'short_text' }];
      const { space, resourceIds } = await setup({ items });
      const r = resourceIds[0];
      const spaces = ds.getRepository(BookingSpace);
      duringFacts = () => spaces.update(space.id, { maxPeople: 1 }).then(() => undefined);
      try {
        expect(
          await refusal(book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [BOB] }))
        ).toEqual({ code: 'too-many-people', maxPeople: 1 });
        duringFacts = () =>
          spaces.update(space.id, { maxPeople: null, items: [] }).then(() => undefined);
        expect(await refusal(book(space.id, r, '10:00', '10:30'))).toEqual({
          code: 'space-changed',
        });
      } finally {
        duringFacts = null;
      }
    });

    it('refuses too many people and a holder named as a participant', async () => {
      const { space, resourceIds } = await setup({ maxPeople: 2 });
      const r = resourceIds[0];
      expect(
        await refusal(book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [BOB, CAROL] }))
      ).toEqual({ code: 'too-many-people', maxPeople: 2 });
      expect(
        await refusal(book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [ALICE] }))
      ).toEqual({ code: 'holder-is-participant' });
      await expect(
        book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [BOB] })
      ).resolves.toHaveProperty('id');
    });

    it('honours a block between the HOLDER and a participant when the organiser books on behalf (D21)', async () => {
      const { space, resourceIds } = await setup();
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [DAN, BOB]);
      expect(
        await refusal(
          book(space.id, resourceIds[0], '10:00', '10:30', ORGA, {
            holderId: BOB,
            participantIds: [DAN],
          })
        )
      ).toEqual({ code: 'participant-blocked' });
    });
  });
});
