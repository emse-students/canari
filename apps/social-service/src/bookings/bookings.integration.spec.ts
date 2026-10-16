/**
 * THE BOOKINGS SCHEMA AGAINST A REAL POSTGRESQL - migration 087 (WP-B1).
 *
 * The one rule this module cannot hold anywhere else is the database's: ONE live booking per
 * resource and instant (D12, D33). A unit spec with a mocked repository proves nothing about it, so
 * this file runs migration 087 (twice: the deploy may replay it) on a real connection and races real
 * transactions on the last slot. It also proves what the constraint must NOT refuse - adjacent
 * half-open ranges, another resource, a range freed by a cancellation - and that deleting a space
 * (or its association) deletes everything under it (D27), and what a deleted ACCOUNT leaves behind
 * (`deleteBookingsUserData`). The entities read and write the tables, which pins their column names
 * to the migration's.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files: without it the file reports
 * as skipped rather than passing. Run it against a throwaway PostgreSQL:
 *
 *   docker run -d --rm --name bookings-it -e POSTGRES_PASSWORD=it -p 55439:5432 postgres:18-alpine
 *   SOCIAL_IT_DATABASE_URL=postgres://postgres:it@localhost:55439/postgres bun run test -- bookings.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. The `btree_gist` extension the
 * migration creates is database-wide and stays (it is created in `public`, as in production).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { BOOKING_ENTITIES } from './bookings.module';
import { Booking, BOOKINGS_NO_OVERLAP } from './entities/booking.entity';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { isExclusionViolation } from '../common/pg-errors';
import { Association } from '../associations/entities/association.entity';
import { deleteBookingsUserData } from './bookings-account-deletion';
import { DELETED_ACCOUNT_ID } from './deleted-account';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '087_bookings.sql'), 'utf8');

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00Z`);

maybe('bookings schema against PostgreSQL (migration 087)', () => {
  const schema = `bookings_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** A client of its own, on the throwaway schema: one per concurrent transaction. */
  async function connection(): Promise<Client> {
    const c = new Client({ connectionString: URL, options: `-c search_path=${schema}` });
    await c.connect();
    return c;
  }

  /**
   * Resolves once the backend `pid` is WAITING ON A LOCK, read from `pg_stat_activity` - the proof
   * that the second insert really reached the server and is held by the first transaction, rather
   * than a race the test won by arriving late. Bounded: 200 reads, then it fails.
   */
  async function blocked(pid: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
        [pid]
      );
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }

  const pidOf = (c: Client) => (c as unknown as { processID: number }).processID;

  async function space(associationId: string | null = null): Promise<BookingSpace> {
    return ds.getRepository(BookingSpace).save({
      ownerId: ALICE,
      associationId,
      name: 'Salle de musique',
      stepMinutes: 30,
      maxSteps: 4,
    });
  }

  async function resource(spaceId: string): Promise<BookingResource> {
    return ds.getRepository(BookingResource).save({ spaceId, name: 'Salle' });
  }

  const bookingRow = (resourceId: string, from: string, to: string, holderId = ALICE) => ({
    resourceId,
    holderId,
    holderName: 'Alice',
    bookedById: holderId,
    startsAt: at(from),
    endsAt: at(to),
  });

  const INSERT = `INSERT INTO bookings ("resourceId", "holderId", "holderName", "bookedById", "startsAt", "endsAt")
                  VALUES ($1, $2, 'x', $2, $3, $4) RETURNING id`;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      // Association is named by BookingSpace's relation; only its id column exists in this schema.
      entities: [...BOOKING_ENTITIES, Association],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // The one table 087 references, in the shape it needs of it.
    await q(`CREATE TABLE associations (id uuid PRIMARY KEY)`);
    // Applied TWICE: the deploy re-runs a file whose successor failed, so 087 must be a no-op then.
    await q(MIGRATION);
    await q(MIGRATION);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('creates the overlap exclusion once, in this schema', async () => {
    const rows = await q(
      `SELECT contype FROM pg_constraint
        WHERE conname = $1 AND connamespace = to_regnamespace($2)::oid`,
      [BOOKINGS_NO_OVERLAP, schema]
    );
    expect(rows).toEqual([{ contype: 'x' }]);
  });

  it('builds the schema the entities declare: synchronize would change nothing on a booking table', async () => {
    // Production gets the schema from 087, development from `synchronize`. Were they to differ,
    // a development database copied from production would be silently rewritten at boot (TypeORM
    // drops a constraint it does not know by name). The `associations` stub is left out, and with
    // it the one foreign key into it: against the stub TypeORM re-creates that key because the
    // stub is not the `Association` entity. Against a real `associations` table (a probe run
    // 2026-10-16 on a synchronize-built one) the list was empty, that key included.
    const pending = (await ds.driver.createSchemaBuilder().log()).upQueries
      .map((query) => query.query)
      .filter((sql) => /booking/.test(sql) && !/booking_spaces_association_fk/.test(sql));
    expect(pending).toEqual([]);
  });

  describe('two concurrent inserts on the last slot', () => {
    it('the second waits for the first, then is refused with 23P01 once it commits', async () => {
      const r = await resource((await space()).id);
      const [a, b] = [await connection(), await connection()];
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        await a.query(INSERT, [r.id, ALICE, at('10:00'), at('10:30')]);
        // B's insert blocks on A's uncommitted row: the exclusion check waits for A's outcome.
        const second = b.query(INSERT, [r.id, BOB, at('10:00'), at('10:30')]).then(
          () => 'inserted',
          (err: unknown) => err
        );
        await blocked(pidOf(b));
        await a.query('COMMIT');
        const outcome = await second;
        await b.query('ROLLBACK');

        expect(isExclusionViolation(outcome)).toBe(true);
        expect((outcome as { constraint?: string }).constraint).toBe(BOOKINGS_NO_OVERLAP);
      } finally {
        await a.end();
        await b.end();
      }
      const live = await q(`SELECT "holderId" FROM bookings WHERE "resourceId" = $1`, [r.id]);
      expect(live).toEqual([{ holderId: ALICE }]);
    });

    it('the second goes through once the first ROLLS BACK: a lost race frees nothing it did not hold', async () => {
      const r = await resource((await space()).id);
      const [a, b] = [await connection(), await connection()];
      try {
        await a.query('BEGIN');
        await a.query(INSERT, [r.id, ALICE, at('10:00'), at('10:30')]);
        const second = b.query(INSERT, [r.id, BOB, at('10:15'), at('10:45')]);
        await blocked(pidOf(b));
        await a.query('ROLLBACK');
        await expect(second).resolves.toBeDefined();
      } finally {
        await a.end();
        await b.end();
      }
      const live = await q(`SELECT "holderId" FROM bookings WHERE "resourceId" = $1`, [r.id]);
      expect(live).toEqual([{ holderId: BOB }]);
    });

    /** Eight clients race one slot of a fresh resource; the SQLSTATE of each loser, sorted. */
    async function race(
      clients: Client[],
      attempt: (c: Client, resourceId: string, holderId: string) => Promise<unknown>
    ): Promise<{ won: number; lostCodes: string[] }> {
      const r = await resource((await space()).id);
      const outcomes = await Promise.allSettled(
        clients.map((c, i) => attempt(c, r.id, String(i).repeat(64)))
      );
      const lostCodes = outcomes
        .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
        .map((o) => String(o.reason?.code))
        .sort();
      const live = await q(`SELECT count(*)::int AS n FROM bookings WHERE "resourceId" = $1`, [
        r.id,
      ]);
      expect(live[0].n).toBe(1);
      return { won: outcomes.length - lostCodes.length, lostCodes };
    }

    it('exactly one of eight simultaneous BARE inserts wins - but a loser may be told 40P01', async () => {
      // MEASURED 2026-10-16, PostgreSQL 18.6: with eight bare inserts the seven losers were all
      // told 40P01 (deadlock_detected), not 23P01. Each inserted its tuple, then found the others'
      // uncommitted tuples and waited on them - a cycle the deadlock detector breaks. The RULE
      // holds (one winner, every time); the ANSWER is not a typed "slot taken". Hence the next test.
      const clients = await Promise.all(Array.from({ length: 8 }, () => connection()));
      try {
        for (let round = 0; round < 3; round++) {
          const { won, lostCodes } = await race(clients, (c, resourceId, holderId) =>
            c.query(INSERT, [resourceId, holderId, at('14:00'), at('14:25')])
          );
          expect(won).toBe(1);
          expect(lostCodes.filter((code) => code !== '23P01' && code !== '40P01')).toEqual([]);
        }
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      // Each deadlock costs the server's `deadlock_timeout` (1 s) before it is broken.
    }, 120_000);

    it('with the resource row locked first, exactly one wins and EVERY loser is told 23P01', async () => {
      // The shape WP-B3 must use: `SELECT ... FOR UPDATE` on the resource, then the insert, in one
      // transaction. Inserts on one resource are serialised by the row lock, so a loser meets a
      // COMMITTED conflict and gets the exclusion's own SQLSTATE - never a deadlock.
      const clients = await Promise.all(Array.from({ length: 8 }, () => connection()));
      try {
        for (let round = 0; round < 20; round++) {
          const { won, lostCodes } = await race(clients, async (c, resourceId, holderId) => {
            await c.query('BEGIN');
            try {
              await c.query(`SELECT id FROM booking_resources WHERE id = $1 FOR UPDATE`, [
                resourceId,
              ]);
              await c.query(INSERT, [resourceId, holderId, at('14:00'), at('14:25')]);
              await c.query('COMMIT');
            } catch (err) {
              await c.query('ROLLBACK');
              throw err;
            }
          });
          expect(won).toBe(1);
          expect(lostCodes).toEqual(Array(7).fill('23P01'));
        }
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    }, 120_000);
  });

  describe('what the rule does not refuse', () => {
    it('takes adjacent half-open ranges [10:00, 10:30) and [10:30, 11:00)', async () => {
      const r = await resource((await space()).id);
      const repo = ds.getRepository(Booking);
      await repo.save(bookingRow(r.id, '10:00', '10:30'));
      await expect(repo.save(bookingRow(r.id, '10:30', '11:00', BOB))).resolves.toBeDefined();
      // One minute of overlap is an overlap.
      await expect(repo.save(bookingRow(r.id, '10:59', '11:30', BOB))).rejects.toMatchObject({
        code: '23P01',
      });
    });

    it('takes the same instant on another resource of the same space', async () => {
      const s = await space();
      const [r1, r2] = [await resource(s.id), await resource(s.id)];
      const repo = ds.getRepository(Booking);
      await repo.save(bookingRow(r1.id, '16:20', '16:40'));
      await expect(repo.save(bookingRow(r2.id, '16:20', '16:40', BOB))).resolves.toBeDefined();
    });

    it('frees the range of a CANCELLED booking, and the cancelled row stays as history', async () => {
      const r = await resource((await space()).id);
      const repo = ds.getRepository(Booking);
      const first = await repo.save(bookingRow(r.id, '09:00', '10:00'));
      await expect(repo.save(bookingRow(r.id, '09:00', '10:00', BOB))).rejects.toMatchObject({
        code: '23P01',
      });

      await repo.update(first.id, { cancelledAt: new Date(), cancelledById: ALICE });
      await expect(repo.save(bookingRow(r.id, '09:00', '10:00', BOB))).resolves.toBeDefined();

      // The history keeps both rows; reviving the cancelled one now collides with the live one.
      expect(await repo.count({ where: { resourceId: r.id } })).toBe(2);
      await expect(
        repo.update(first.id, { cancelledAt: null, cancelledById: null })
      ).rejects.toMatchObject({ code: '23P01' });
    });
  });

  describe('the shape the checks hold', () => {
    it('refuses an empty or reversed range', async () => {
      const r = await resource((await space()).id);
      const repo = ds.getRepository(Booking);
      await expect(repo.save(bookingRow(r.id, '10:00', '10:00'))).rejects.toThrow(/bookings_order/);
      await expect(repo.save(bookingRow(r.id, '11:00', '10:00'))).rejects.toThrow(/bookings_order/);
    });

    it('refuses a cancellation without its author', async () => {
      const r = await resource((await space()).id);
      const repo = ds.getRepository(Booking);
      const b = await repo.save(bookingRow(r.id, '12:00', '12:30'));
      await expect(repo.update(b.id, { cancelledAt: new Date() })).rejects.toThrow(
        /bookings_cancellation_pair/
      );
    });

    it('refuses a step space with no step, and a retention outside 1..30 (D23)', async () => {
      const repo = ds.getRepository(BookingSpace);
      await expect(
        repo.save({ ownerId: ALICE, name: 'x', slotMode: 'step', stepMinutes: null, maxSteps: 1 })
      ).rejects.toThrow(/booking_spaces_step_shape/);
      await expect(
        repo.save({ ownerId: ALICE, name: 'x', slotMode: 'slots', retentionDays: 31 })
      ).rejects.toThrow(/booking_spaces_retention_days/);
      const slots = await repo.save({ ownerId: ALICE, name: 'Entretiens', slotMode: 'slots' });
      expect(slots.retentionDays).toBe(7);
      expect(slots.timeZone).toBe('Europe/Paris');
      expect(slots.nameVisibility).toBe('occupied');
    });

    it('refuses an availability rule that is both weekly and dated, or neither', async () => {
      const r = await resource((await space()).id);
      const insert = (weekday: number | null, onDate: string | null) =>
        q(
          `INSERT INTO booking_availability_rules ("resourceId", weekday, "onDate", "startTime", "endTime")
           VALUES ($1, $2, $3, '14:00', '18:45')`,
          [r.id, weekday, onDate]
        );
      await expect(insert(1, '2026-11-02')).rejects.toThrow(/booking_availability_rules_one_kind/);
      await expect(insert(null, null)).rejects.toThrow(/booking_availability_rules_one_kind/);
      await expect(insert(8, null)).rejects.toThrow(/booking_availability_rules_weekday/);
      await expect(insert(1, null)).resolves.toBeDefined();
      await expect(insert(null, '2026-11-02')).resolves.toBeDefined();
    });
  });

  describe('deleting a space deletes everything (D27)', () => {
    async function populate(s: BookingSpace): Promise<string> {
      const r = await resource(s.id);
      await q(
        `INSERT INTO booking_availability_rules ("resourceId", weekday, "startTime", "endTime")
         VALUES ($1, 1, '08:00', '22:00')`,
        [r.id]
      );
      await q(
        `INSERT INTO booking_availability_exceptions ("resourceId", "fromDate", "toDate")
         VALUES ($1, '2026-12-24', '2027-01-02')`,
        [r.id]
      );
      await q(
        `INSERT INTO booking_blocks ("resourceId", "startsAt", "endsAt", "createdById")
         VALUES ($1, $2, $3, $4)`,
        [r.id, at('20:00'), at('22:00'), ALICE]
      );
      const b = await ds.getRepository(Booking).save(bookingRow(r.id, '18:00', '19:00'));
      await ds
        .getRepository(BookingParticipant)
        .save({ bookingId: b.id, userId: BOB, userName: 'Bob' });
      return r.id;
    }

    const TABLES = [
      'booking_resources',
      'booking_availability_rules',
      'booking_availability_exceptions',
      'booking_blocks',
      'bookings',
      'booking_participants',
    ];

    /** Rows of each child table under one space, keyed by table. */
    async function countsUnder(spaceId: string): Promise<Record<string, number>> {
      const sql: Record<string, string> = {
        booking_resources: `SELECT count(*)::int AS n FROM booking_resources WHERE "spaceId" = $1`,
        booking_availability_rules: `SELECT count(*)::int AS n FROM booking_availability_rules x JOIN booking_resources r ON r.id = x."resourceId" WHERE r."spaceId" = $1`,
        booking_availability_exceptions: `SELECT count(*)::int AS n FROM booking_availability_exceptions x JOIN booking_resources r ON r.id = x."resourceId" WHERE r."spaceId" = $1`,
        booking_blocks: `SELECT count(*)::int AS n FROM booking_blocks x JOIN booking_resources r ON r.id = x."resourceId" WHERE r."spaceId" = $1`,
        bookings: `SELECT count(*)::int AS n FROM bookings x JOIN booking_resources r ON r.id = x."resourceId" WHERE r."spaceId" = $1`,
        booking_participants: `SELECT count(*)::int AS n FROM booking_participants p JOIN bookings x ON x.id = p."bookingId" JOIN booking_resources r ON r.id = x."resourceId" WHERE r."spaceId" = $1`,
      };
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = (await q(sql[t], [spaceId]))[0].n;
      return out;
    }

    /** Rows of each child table across the whole schema. */
    async function totals(): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = (await q(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
      return out;
    }

    it('removes every row under the deleted space and none under another', async () => {
      const [doomed, kept] = [await space(), await space()];
      await populate(doomed);
      await populate(kept);
      const one = Object.fromEntries(TABLES.map((t) => [t, 1]));
      expect(await countsUnder(doomed.id)).toEqual(one);
      const before = await totals();

      await ds.getRepository(BookingSpace).delete(doomed.id);

      expect(await countsUnder(kept.id)).toEqual(one);
      const after = await totals();
      for (const t of TABLES) expect(before[t] - after[t]).toBe(1);
    });

    it('removes an association space with its association', async () => {
      const association = randomUUID();
      await q(`INSERT INTO associations (id) VALUES ($1)`, [association]);
      const s = await space(association);
      const resourceId = await populate(s);

      await q(`DELETE FROM associations WHERE id = $1`, [association]);

      expect(await ds.getRepository(BookingSpace).findOneBy({ id: s.id })).toBeNull();
      expect(await ds.getRepository(Booking).countBy({ resourceId })).toBe(0);
    });
  });

  describe('a deleted account (deleteBookingsUserData)', () => {
    // Past and coming are read against the server's now(), so the fixtures sit far on either side
    // of any date this test may run on - never near a wall clock.
    const PAST = {
      startsAt: new Date('2020-03-02T10:00:00Z'),
      endsAt: new Date('2020-03-02T11:00:00Z'),
    };
    const COMING = {
      startsAt: new Date('2099-03-02T10:00:00Z'),
      endsAt: new Date('2099-03-02T11:00:00Z'),
    };
    const CAROL = 'c'.repeat(64);
    const DAN = 'd'.repeat(64);

    /** A space owned by `ownerId` (personal unless an association is given) with one resource. */
    async function spaceOf(ownerId: string, associationId: string | null = null) {
      const s = await ds.getRepository(BookingSpace).save({
        ownerId,
        associationId,
        name: 'x',
        stepMinutes: 30,
        maxSteps: 4,
      });
      return { space: s, resource: await resource(s.id) };
    }

    async function book(
      resourceId: string,
      when: { startsAt: Date; endsAt: Date },
      holderId: string,
      extra: Partial<Booking> = {}
    ): Promise<Booking> {
      return ds.getRepository(Booking).save({
        resourceId,
        holderId,
        holderName: `name of ${holderId.slice(0, 1)}`,
        bookedById: holderId,
        answers: { q_year: '2A' },
        ...when,
        ...extra,
      });
    }

    const get = (id: string) => ds.getRepository(Booking).findOneByOrFail({ id });

    it('deletes a PERSONAL space of the account with everything under it, and no other', async () => {
      const mine = await spaceOf(CAROL);
      const someoneElses = await spaceOf(DAN);
      await book(mine.resource.id, PAST, DAN);

      const outcome = await deleteBookingsUserData(ds.manager, CAROL);

      expect(outcome.personalSpacesDeleted).toBe(1);
      expect(await ds.getRepository(BookingSpace).findOneBy({ id: mine.space.id })).toBeNull();
      expect(await ds.getRepository(Booking).countBy({ resourceId: mine.resource.id })).toBe(0);
      expect(
        await ds.getRepository(BookingSpace).findOneBy({ id: someoneElses.space.id })
      ).not.toBeNull();
    });

    it('keeps an ASSOCIATION space it created, under the tombstone', async () => {
      const association = randomUUID();
      await q(`INSERT INTO associations (id) VALUES ($1)`, [association]);
      const { space: s } = await spaceOf(CAROL, association);

      await deleteBookingsUserData(ds.manager, CAROL);

      expect((await ds.getRepository(BookingSpace).findOneByOrFail({ id: s.id })).ownerId).toBe(
        DELETED_ACCOUNT_ID
      );
    });

    it('freezes a PAST booking it held: id tombstoned, name kept, answers purged', async () => {
      const { resource: r } = await spaceOf(DAN);
      const past = await book(r.id, PAST, CAROL);

      await deleteBookingsUserData(ds.manager, CAROL);

      const row = await get(past.id);
      expect(row.holderId).toBe(DELETED_ACCOUNT_ID);
      expect(row.bookedById).toBe(DELETED_ACCOUNT_ID);
      expect(row.holderName).toBe('name of c');
      expect(row.answers).toBeNull();
      expect(row.answersPurgedAt).not.toBeNull();
      expect(row.cancelledAt).toBeNull();
    });

    it('cancels a COMING booking it held, which frees the slot', async () => {
      const { resource: r } = await spaceOf(DAN);
      const coming = await book(r.id, COMING, CAROL);

      const outcome = await deleteBookingsUserData(ds.manager, CAROL);

      expect(outcome.comingBookingsCancelled).toBe(1);
      const row = await get(coming.id);
      expect(row.cancelledAt).not.toBeNull();
      expect(row.cancelledById).toBe(DELETED_ACCOUNT_ID);
      expect(row.holderId).toBe(DELETED_ACCOUNT_ID);
      await expect(book(r.id, COMING, DAN)).resolves.toBeDefined();
    });

    it('leaves LIVE a coming booking it made on behalf of someone else: only the id goes', async () => {
      const { resource: r } = await spaceOf(DAN);
      const forDan = await book(r.id, COMING, DAN, { bookedById: CAROL });

      const outcome = await deleteBookingsUserData(ds.manager, CAROL);

      expect(outcome.comingBookingsCancelled).toBe(0);
      const row = await get(forDan.id);
      expect(row.cancelledAt).toBeNull();
      expect(row.holderId).toBe(DAN);
      expect(row.bookedById).toBe(DELETED_ACCOUNT_ID);
      expect(row.answers).toEqual({ q_year: '2A' });
    });

    it('tombstones what it did as organiser: booked on behalf, cancelled, blocked', async () => {
      const { resource: r } = await spaceOf(DAN);
      const onBehalf = await book(r.id, PAST, DAN, { bookedById: CAROL });
      const cancelled = await book(r.id, PAST, DAN, {
        startsAt: new Date('2020-03-03T10:00:00Z'),
        endsAt: new Date('2020-03-03T11:00:00Z'),
        cancelledAt: new Date('2020-03-01T00:00:00Z'),
        cancelledById: CAROL,
      });
      await q(
        `INSERT INTO booking_blocks ("resourceId", "startsAt", "endsAt", "createdById") VALUES ($1, $2, $3, $4)`,
        [r.id, PAST.startsAt, PAST.endsAt, CAROL]
      );

      await deleteBookingsUserData(ds.manager, CAROL);

      expect((await get(onBehalf.id)).bookedById).toBe(DELETED_ACCOUNT_ID);
      expect((await get(onBehalf.id)).holderId).toBe(DAN);
      expect((await get(cancelled.id)).cancelledById).toBe(DELETED_ACCOUNT_ID);
      const blocks = await q(`SELECT "createdById" FROM booking_blocks WHERE "resourceId" = $1`, [
        r.id,
      ]);
      expect(blocks).toEqual([{ createdById: DELETED_ACCOUNT_ID }]);
    });

    it('tombstones its participations, withdraws the coming one, and two tombstones share a booking', async () => {
      const { resource: r } = await spaceOf(DAN);
      const past = await book(r.id, PAST, DAN);
      const coming = await book(r.id, COMING, DAN);
      const participants = ds.getRepository(BookingParticipant);
      await participants.save([
        { bookingId: past.id, userId: CAROL, userName: 'Carol' },
        { bookingId: past.id, userId: BOB, userName: 'Bob' },
        { bookingId: coming.id, userId: CAROL, userName: 'Carol' },
      ]);

      const outcome = await deleteBookingsUserData(ds.manager, CAROL);
      // A second deleted account in the SAME booking: the partial unique index lets both tombstones be.
      await deleteBookingsUserData(ds.manager, BOB);

      expect(outcome.comingParticipationsWithdrawn).toBe(1);
      const pastRows = await participants.find({
        where: { bookingId: past.id },
        order: { userName: 'ASC' },
      });
      expect(pastRows.map((p) => [p.userId, p.userName, p.withdrawnAt])).toEqual([
        [DELETED_ACCOUNT_ID, 'Bob', null],
        [DELETED_ACCOUNT_ID, 'Carol', null],
      ]);
      const comingRow = await participants.findOneByOrFail({ bookingId: coming.id });
      expect(comingRow.userId).toBe(DELETED_ACCOUNT_ID);
      expect(comingRow.withdrawnAt).not.toBeNull();
      // A LIVE account still appears once per booking.
      await participants.save({ bookingId: past.id, userId: DAN, userName: 'Dan' });
      await expect(
        participants.save({ bookingId: past.id, userId: DAN, userName: 'Dan', id: undefined })
      ).rejects.toThrow(/booking_participants_booking_user_uq/);
    });

    it('unlinks a resource linked to the account, and a second run changes nothing', async () => {
      const { resource: r } = await spaceOf(DAN);
      await ds.getRepository(BookingResource).update(r.id, { linkedUserId: CAROL });

      await deleteBookingsUserData(ds.manager, CAROL);
      const again = await deleteBookingsUserData(ds.manager, CAROL);

      expect(
        (await ds.getRepository(BookingResource).findOneByOrFail({ id: r.id })).linkedUserId
      ).toBeNull();
      expect(again).toEqual({
        personalSpacesDeleted: 0,
        comingBookingsCancelled: 0,
        comingParticipationsWithdrawn: 0,
      });
    });
  });
});
