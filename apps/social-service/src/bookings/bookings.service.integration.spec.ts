/**
 * THE BOOKINGS API'S RULES AGAINST A REAL POSTGRESQL (WP-B3, and the organiser's side, WP-B4).
 *
 * `BookingsService` and `BookingSpacesService` are run on a real connection, with migrations 087 onwards applied to a throwaway
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
import { createHmac, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import {
  HttpException,
  Module,
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { BOOKING_ENTITIES } from './bookings.module';
import { BookingsService, NEAR_NOW_MS, type Actor } from './bookings.service';
import {
  BOOKINGS_ERASURE_STATEMENTS,
  runErasureStatements,
  type ErasureStatement,
} from '../internal/account-erasure';
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
import type { UserTagService } from '../users/user-tag.service';
import { BookingSpacesService } from './booking-spaces.service';
import { bookingCalendarPath } from './booking-calendar';
import { BookingSpacesController } from './booking-spaces.controller';
import { MAX_PERSONAL_SPACES, MAX_RESOURCES_PER_SPACE } from './dto/space.dto';
import { BookingFilesService } from './booking-files.service';
import { BookingFile } from './entities/booking-file.entity';
import type { BookingPosterMedia } from './booking-poster-media';
import type { FormFilesService } from '../forms/form-files.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { BookingReminderScheduler } from './booking-reminder.scheduler';
import type { PostNotificationsService } from '../posts/post-notifications.service';

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
  let organiser: BookingSpacesService;
  let notices: BookingNotificationsService;
  let reminders: BookingReminderScheduler;
  /** Every bell row handed to the notification pipeline (WP-N), one entry per recipient. */
  const told: {
    to: string;
    type: string;
    text: string;
    actorName?: string;
    actorId: string;
    associationId?: string;
    bookingId: string;
    meta?: Record<string, unknown>;
  }[] = [];
  /** Every PUSH the pipeline would send - what a lock screen shows - one entry per recipient. */
  const pushed: {
    to: string;
    type: string;
    text: string;
    actorName?: string;
    actorId: string;
    associationId?: string;
    associationLogoMediaId?: string | null;
  }[] = [];
  /** `account:association` pairs holding MANAGE_BOOKINGS. */
  const grants = new Set<string>();
  /** The audience facts of an account, as `PricingFactsService` would build them. */
  const facts = new Map<string, Record<string, unknown>>();
  /** Runs while the facts are built - i.e. between `book`'s first read of the space and its lock. */
  let duringFacts: (() => Promise<void>) | null = null;
  /** The answers each facts build was handed, in order. */
  const builtAnswers: Record<string, string[]>[] = [];
  /** core-service's profile call fails while set (`listedSpaces`). */
  let profileDown = false;
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
    await q(
      `CREATE TABLE associations (id uuid PRIMARY KEY, name varchar, archived boolean NOT NULL DEFAULT false,
         "logoUrl" varchar, "logoMediaId" uuid)`
    );
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
      mayActOnAny: async (
        userId: string,
        ids: string[],
        flag: number,
        opts?: { isGlobalAdmin?: boolean }
      ) =>
        new Set(
          ids.filter(
            (id) =>
              opts?.isGlobalAdmin ||
              (flag === AssociationPermissionFlag.MANAGE_BOOKINGS && grants.has(`${userId}:${id}`))
          )
        ),
    } as unknown as AssociationsService;
    const pricingFacts = {
      build: async ({ userId, answers }: { userId: string; answers: Record<string, string[]> }) => {
        builtAnswers.push(answers);
        await duringFacts?.();
        return facts.get(userId) ?? {};
      },
      profileFor: async (userId: string, needProfile: boolean) => {
        if (!needProfile) return { promo: null, formation: null };
        if (profileDown) throw new ServiceUnavailableException('core-service is down');
        const f = facts.get(userId) ?? {};
        return { promo: f.promo ?? null, formation: f.formation ?? null };
      },
      cotisationTiersByAssociation: async (userId: string, ids: string[]) =>
        new Map(ids.map((id) => [id, (facts.get(userId)?.cotisationTiers as never) ?? []])),
    } as unknown as PricingFactsService;
    const repo = <T extends object>(e: new () => T) => ds.getRepository(e);
    const slots = (slotsService = new BookingSlotsService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(BookingAvailabilityRule),
      repo(BookingAvailabilityException),
      repo(BookingBlock),
      repo(Booking)
    ));
    // The media service is not under test here (WP-B6's files have their own integration spec,
    // `bookings.files.integration.spec.ts`): a store that refuses to be reached says so if used.
    const unreachable = () => {
      throw new Error('the media service is not part of this spec');
    };
    // The notification pipeline is `PostNotificationsService`'s, with its own specs: what is under
    // test here is WHO each booking change reaches, and with which line.
    type Notice = {
      recipientIds: string[];
      actorId: string;
      type: string;
      text: string;
      actorName?: string;
      associationId?: string;
      associationLogoMediaId?: string | null;
      postId: string;
      skipPush?: boolean;
      meta?: Record<string, unknown>;
    };
    const push = (d: Omit<Notice, 'postId' | 'recipientIds'>, to: string[]) => {
      for (const id of to) {
        pushed.push({
          to: id,
          type: d.type,
          text: d.text,
          actorName: d.actorName,
          actorId: d.actorId,
          associationId: d.associationId,
          associationLogoMediaId: d.associationLogoMediaId,
        });
      }
    };
    const pipeline = {
      createNotifications: async (d: Notice) => {
        const to = [...new Set(d.recipientIds)].filter((id) => id !== d.actorId);
        for (const id of to) {
          told.push({
            to: id,
            type: d.type,
            text: d.text,
            actorName: d.actorName,
            actorId: d.actorId,
            associationId: d.associationId,
            bookingId: d.postId,
            meta: d.meta,
          });
        }
        if (!d.skipPush) push(d, to);
        return to.length;
      },
      pushNotice: async (d: Omit<Notice, 'postId'>) => {
        const to = [...new Set(d.recipientIds)].filter((id) => id !== d.actorId);
        push(d, to);
        return to.length;
      },
      resolveActorName: async (id: string) => `name-of-${id.slice(0, 4)}`,
      createNotification: async (d: Omit<Notice, 'recipientIds'> & { recipientId: string }) => {
        told.push({
          to: d.recipientId,
          type: d.type,
          text: d.text,
          actorName: d.actorName,
          actorId: d.actorId,
          associationId: d.associationId,
          bookingId: d.postId,
        });
        push(d, [d.recipientId]);
      },
    } as unknown as PostNotificationsService;
    notices = new BookingNotificationsService(
      repo(Booking),
      repo(BookingParticipant),
      repo(BookingResource),
      repo(BookingSpace),
      pipeline
    );
    reminders = new BookingReminderScheduler(repo(Booking), notices);
    service = new BookingsService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(Booking),
      repo(BookingParticipant),
      repo(BookingBlock),
      slots,
      associations,
      pricingFacts,
      new BookingFilesService(repo(BookingFile), {
        storeBlob: unreachable,
        fetchBlob: unreachable,
        purgeBlobs: unreachable,
      } as unknown as FormFilesService),
      notices
    );
    organiser = new BookingSpacesService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(BookingAvailabilityRule),
      repo(BookingAvailabilityException),
      repo(Booking),
      slots,
      associations,
      { listCotisationTiers: async () => [] } as unknown as UserTagService,
      { claim: async () => {}, releaseUncited: async () => {} } as unknown as BookingPosterMedia,
      notices
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

  describe('an account erased while its resource is being booked', () => {
    // The erasure reads past and coming against the server's now(), so this day sits far ahead of
    // any date the test may run on, and `book` is handed a now just before it.
    const DAY = '2099-03-02';
    const DAY_NOW = Date.parse('2099-03-01T12:00:00Z');
    const slot = (resourceId: string) => ({
      resourceId,
      startsAt: on('14:00', DAY),
      endsAt: on('14:30', DAY),
    });
    const LINKED_FIRST = new Set(['bookings_space_owner', 'bookings_linked_resource']);
    /** The order before review: space and resource rows rewritten AFTER the bookings. */
    const BROKEN_ORDER: readonly ErasureStatement[] = [
      ...BOOKINGS_ERASURE_STATEMENTS.filter((s) => !LINKED_FIRST.has(s.label)),
      ...BOOKINGS_ERASURE_STATEMENTS.filter((s) => LINKED_FIRST.has(s.label)),
    ];

    /** Resolves once some backend of this database waits on a lock. */
    async function someoneWaitsOnALock() {
      for (let i = 0; i < 500; i++) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no backend ever waited on a lock');
    }

    /**
     * CAROL is linked to the resource and holds a coming booking on it. Her erasure runs
     * `statements` in ONE transaction on its own connection; once her booking is cancelled (and
     * before the transaction ends), ALICE books the same slot. What ALICE's booking came to.
     */
    async function race(statements: readonly ErasureStatement[]) {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await q(`UPDATE booking_resources SET "linkedUserId" = $1 WHERE id = $2`, [CAROL, r]);
      await service.book(space.id, slot(r), as(CAROL), DAY_NOW);
      // PostgreSQL aborts the backend whose `deadlock_timeout` runs out first. The booker waits
      // first, so it is normally the one - but under a loaded run the erasure's check could fire
      // first and the erasure would be the victim (seen 2026-10-18 with the specs in parallel).
      // A longer timeout on the erasure's own connection makes the booker the victim, always.
      const c = new Client({
        connectionString: URL,
        options: `-c search_path=${schema} -c deadlock_timeout=20s`,
      });
      await c.connect();
      const db = {
        write: async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount ?? 0,
        read: async <T>(sql: string, params: unknown[]) => (await c.query(sql, params)).rows as T[],
      };
      let booking: Promise<PromiseSettledResult<unknown>> | null = null;
      try {
        await c.query('BEGIN');
        for (const statement of statements) {
          await runErasureStatements(db, [statement], CAROL);
          if (statement.label === 'bookings_coming_cancelled') {
            booking = Promise.allSettled([
              service.book(space.id, slot(r), as(ALICE), DAY_NOW),
            ]).then(([o]) => o);
            await someoneWaitsOnALock();
          }
        }
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
      return booking!;
    }

    it('the erasure takes space, resource, booking like the booking path: no deadlock, the booking lands', async () => {
      const outcome = await race(BOOKINGS_ERASURE_STATEMENTS);
      expect(outcome.status).toBe('fulfilled');
    }, 30_000);

    it('a writer that breaks the order: the booker is told try-again, never a 500', async () => {
      const outcome = await race(BROKEN_ORDER);
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason as HttpException;
      expect(reason.getResponse()).toEqual({ code: 'try-again' });
    }, 30_000);
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

    it('refuses a block over a block of the same resource: the same range twice writes one row', async () => {
      const { resourceIds } = await setup({}, 2);
      const [r, other] = resourceIds;
      const first = { startsAt: on('09:00'), endsAt: on('10:00') };
      await service.addBlock(r, first, as(ORGA), NOW);
      const refused = { code: 'block-overlap' };
      expect(await refusal(service.addBlock(r, first, as(ORGA), NOW))).toEqual(refused);
      // Any overlap, whichever side reaches into the other.
      for (const [from, to] of [
        ['09:30', '09:45'],
        ['08:00', '09:15'],
        ['09:45', '11:00'],
        ['08:00', '11:00'],
      ]) {
        expect(
          await refusal(service.addBlock(r, { startsAt: on(from), endsAt: on(to) }, as(ORGA), NOW))
        ).toEqual(refused);
      }
      // Touching ranges and another resource are not overlaps.
      await service.addBlock(r, { startsAt: on('10:00'), endsAt: on('11:00') }, as(ORGA), NOW);
      await service.addBlock(r, { startsAt: on('08:00'), endsAt: on('09:00') }, as(ORGA), NOW);
      await service.addBlock(other, first, as(ORGA), NOW);
      expect(await ds.getRepository(BookingBlock).countBy({ resourceId: r })).toBe(3);
      // Racing the same block: one winner, the rest told it exists.
      const racing = { startsAt: on('15:00'), endsAt: on('16:00') };
      const racers = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.addBlock(r, racing, as(ORGA), NOW).then(
            () => 'won',
            (err: unknown) => refusal(Promise.reject(err))
          )
        )
      );
      expect(racers.filter((x) => x === 'won')).toHaveLength(1);
      // Every loser is told the block exists: never a deadlock or a try-again.
      expect(racers.filter((x) => x !== 'won')).toEqual(Array(4).fill({ code: 'block-overlap' }));
      expect(await ds.getRepository(BookingBlock).countBy({ resourceId: r })).toBe(4);
    });

    it('names the bookings to the linked account as bare ids, and to a stranger not at all', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await ds.getRepository(BookingResource).update(r, { linkedUserId: DAN });
      const { id } = await book(space.id, r, '10:00', '10:30');
      const block = { startsAt: on('09:00'), endsAt: on('12:00') };
      // The body is the code and the ids, never a name: the linked account is not a manager and
      // reads nobody's identity (spaceBookings, the list that carries it, is manager-only).
      expect(await refusal(service.addBlock(r, block, as(DAN), NOW))).toEqual({
        code: 'bookings-inside-block',
        bookingIds: [id],
      });
      expect(await refusal(service.spaceBookings(space.id, as(DAN), 0, 10, [id]))).toEqual({
        code: 'not-manager',
      });
      expect(await refusal(service.addBlock(r, block, as(BOB), NOW))).toEqual({
        code: 'not-manager',
      });
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

    it('lists only the LIVE bookings still to come from `from`, paged by start (WP-R5)', async () => {
      const { space, resourceIds } = await setup();
      const early = await book(space.id, resourceIds[0], '09:00', '09:30');
      const underWay = await book(space.id, resourceIds[0], '10:00', '11:00');
      const cancelled = await book(space.id, resourceIds[0], '12:00', '12:30');
      const next = await book(space.id, resourceIds[0], '13:00', '13:30');
      const last = await book(space.id, resourceIds[0], '14:00', '14:30');
      await service.cancel(cancelled.id, as(ALICE), NOW);
      // Monday 10:30: the 09:00 one has ended, the 10:00 one is under way.
      const from = Date.parse(on('10:30'));

      const first = await service.spaceBookings(space.id, as(ORGA), 0, 2, undefined, from);
      expect(first.items.map((b) => b.id)).toEqual([underWay.id, next.id]);
      expect(first.nextOffset).toBe(2);
      const rest = await service.spaceBookings(space.id, as(ORGA), 2, 2, undefined, from);
      expect(rest.items.map((b) => b.id)).toEqual([last.id]);
      expect(rest.nextOffset).toBeNull();
      // Without `from` the whole history is still there, the ended and the cancelled included.
      const all = await service.spaceBookings(space.id, as(ORGA));
      expect(all.items.map((b) => b.id)).toEqual([
        early.id,
        underWay.id,
        cancelled.id,
        next.id,
        last.id,
      ]);
      expect(
        await refusal(service.spaceBookings(space.id, as(ALICE), 0, 2, undefined, from))
      ).toEqual({ code: 'not-manager' });
    });

    it('narrows the organiser list to the bookings a D29 refusal named, in this space only', async () => {
      const { space, resourceIds } = await setup();
      const other = await setup({ name: 'other' });
      const a = await book(space.id, resourceIds[0], '10:00', '10:30');
      await book(space.id, resourceIds[0], '11:00', '11:30');
      const c = await book(space.id, resourceIds[0], '12:00', '12:30');
      const elsewhere = await book(other.space.id, other.resourceIds[0], '10:00', '10:30');
      const named = await service.spaceBookings(space.id, as(ORGA), 0, 200, [
        c.id,
        a.id,
        elsewhere.id,
      ]);
      expect(named.items.map((b) => b.id)).toEqual([a.id, c.id]);
      expect(named.items[0]).toHaveProperty('holderName');
      await expect(service.spaceBookings(space.id, as(ORGA), 0, 200, [])).resolves.toEqual({
        items: [],
        nextOffset: null,
      });
      expect(await refusal(service.spaceBookings(space.id, as(ALICE), 0, 200, [a.id]))).toEqual({
        code: 'not-manager',
      });
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

    it('a start just behind the server clock is "from now" and moves up to it; an older one is refused', async () => {
      const { resourceIds } = await setup();
      const r = resourceIds[0];
      const now = Date.parse(on('10:15'));
      const late = new Date(now - NEAR_NOW_MS).toISOString();
      const { id } = await service.addBlock(
        r,
        { startsAt: late, endsAt: on('12:00') },
        as(ORGA),
        now
      );
      const row = await ds.getRepository(BookingBlock).findOneByOrFail({ id });
      expect(row.startsAt.toISOString()).toBe(on('10:15'));
      const tooLate = new Date(now - NEAR_NOW_MS - 1).toISOString();
      expect(
        await refusal(
          service.addBlock(r, { startsAt: tooLate, endsAt: on('13:00') }, as(ORGA), now)
        )
      ).toEqual({ code: 'history-frozen' });
      // Moved up to now, a block that ended before the server's now is empty.
      expect(
        await refusal(
          service.addBlock(
            r,
            { startsAt: late, endsAt: new Date(now - 1).toISOString() },
            as(ORGA),
            now
          )
        )
      ).toEqual({ code: 'range' });
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

  describe("the booker's page and the calendar link (WP-B5)", () => {
    const KEY = 'k'.repeat(48);
    let previousKey: string | undefined;
    let previousFrontend: string | undefined;
    beforeAll(() => {
      previousKey = process.env.AGENDA_SIGNING_KEY;
      previousFrontend = process.env.FRONTEND_URL;
      process.env.AGENDA_SIGNING_KEY = KEY;
      process.env.FRONTEND_URL = 'https://canari.example';
    });
    afterAll(() => {
      if (previousKey === undefined) delete process.env.AGENDA_SIGNING_KEY;
      else process.env.AGENDA_SIGNING_KEY = previousKey;
      if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previousFrontend;
    });

    /** The ids of `listedSpaces` among `mine`, in the order they were answered. */
    const listedAmong = async (viewer: string, mine: string[]) =>
      (await service.listedSpaces(as(viewer))).map((s) => s.id).filter((id) => mine.includes(id));

    it('lists the listed spaces whose audience admits the reader, never a link-only one', async () => {
      const open = await setup({ name: '0000 open' });
      const promo = await setup({ name: '0001 promo', audience: { promo: { values: [2024] } } });
      const link = await setup({ name: '0002 link', discoverability: 'link' });
      await q(`UPDATE associations SET name = 'BDA' WHERE id = $1`, [open.space.associationId]);
      facts.set(BOB, { promo: 2024, formation: null, cotisationTiers: [], answers: {} });
      const mine = [open.space.id, promo.space.id, link.space.id];

      expect(await listedAmong(ALICE, mine)).toEqual([open.space.id]);
      expect(await listedAmong(BOB, mine)).toEqual([open.space.id, promo.space.id]);
      // The organiser of all three sees what is listed, the audience aside - and still no link.
      expect(await listedAmong(ORGA, mine)).toEqual([open.space.id, promo.space.id]);

      const row = (await service.listedSpaces(as(ALICE))).find((s) => s.id === open.space.id);
      expect(row).toEqual(
        expect.objectContaining({ associationName: 'BDA', resourceCount: 1, timeZone: 'UTC' })
      );
      expect(row).not.toHaveProperty('privateInfo');
    });

    it("lists a personal space to its owner alone (D43), never an archived association's", async () => {
      const personal = await setup({ name: '0003 personal', associationId: null, ownerId: DAN });
      const archived = await setup({ name: '0004 archived' });
      await q(`UPDATE associations SET archived = true WHERE id = $1`, [
        archived.space.associationId,
      ]);
      const mine = [personal.space.id, archived.space.id];
      expect(await listedAmong(DAN, mine)).toEqual([personal.space.id]);
      for (const viewer of [ALICE, ORGA]) expect(await listedAmong(viewer, mine)).toEqual([]);
      expect(
        (await service.listedSpaces({ userId: STRANGER, isGlobalAdmin: true }))
          .map((s) => s.id)
          .filter((id) => mine.includes(id))
      ).toEqual([]);
    });

    it('lists a review account only the cohort spaces, and a member never one (review-cohort.ts)', async () => {
      const previous = process.env.SERVICE_ACCOUNT_USER_ID;
      process.env.SERVICE_ACCOUNT_USER_ID = DAN;
      try {
        const school = await setup({ name: '0008 school' });
        const reviewer = await setup({ name: '0009 reviewer', ownerId: DAN });
        const personal = await setup({ name: '0010 own', associationId: null, ownerId: DAN });
        const mine = [school.space.id, reviewer.space.id, personal.space.id];
        expect(await listedAmong(DAN, mine)).toEqual([reviewer.space.id, personal.space.id]);
        for (const viewer of [ALICE, ORGA]) {
          expect(await listedAmong(viewer, mine)).toEqual([school.space.id]);
        }
      } finally {
        if (previous === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
        else process.env.SERVICE_ACCOUNT_USER_ID = previous;
      }
    });

    it('keeps the page when core-service fails: only a space needing the profile is left out', async () => {
      const open = await setup({ name: '0005 open' });
      const promo = await setup({ name: '0006 promo', audience: { promo: { values: [2024] } } });
      const cotisants = await setup({
        name: '0007 cotisants',
        audience: { cotisation: { anyTier: true } },
      });
      facts.set(BOB, { promo: 2024, formation: null, cotisationTiers: [null], answers: {} });
      const mine = [open.space.id, promo.space.id, cotisants.space.id];
      expect(await listedAmong(BOB, mine)).toEqual(mine);
      profileDown = true;
      try {
        expect(await listedAmong(BOB, mine)).toEqual([open.space.id, cotisants.space.id]);
      } finally {
        profileDown = false;
      }
    });

    // Owner, 2026-10-30: the forms' "ne detient pas" reaches a space through the same predicate - a
    // space for people WITHOUT the cotisation is neither listed to a holder nor usable by one.
    it('keeps a space for non-holders of a cotisation from a holder, listed and read', async () => {
      const notCotisants = await setup({
        name: '0008 not cotisants',
        audience: { notCotisation: { anyTier: true } },
      });
      const mine = [notCotisants.space.id];
      facts.set(BOB, { promo: null, formation: null, cotisationTiers: [], answers: {} });
      expect(await listedAmong(BOB, mine)).toEqual(mine);
      await expect(service.getSpace(notCotisants.space.id, as(BOB))).resolves.toBeDefined();
      facts.set(BOB, { promo: null, formation: null, cotisationTiers: [null], answers: {} });
      expect(await listedAmong(BOB, mine)).toEqual([]);
      expect(await refusal(service.getSpace(notCotisants.space.id, as(BOB)))).toEqual({
        code: 'audience',
      });
    });

    it("hands the calendar link to the booking's people alone, never for a cancelled one", async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      const { path } = await service.calendarLink(id, as(ALICE));
      expect(path).toMatch(
        new RegExp(`^/api/bookings/${id}/calendar\\.ics\\?u=${ALICE}&sig=[\\w%-]+$`)
      );
      // Each person's link names them: never the same link twice.
      const links = await Promise.all([BOB, ORGA].map((p) => service.calendarLink(id, as(p))));
      expect(new Set([path, ...links.map((l) => l.path)]).size).toBe(3);
      // A global admin who is not of the booking gets none: its fetch would refuse it.
      expect(
        await refusal(service.calendarLink(id, { userId: STRANGER, isGlobalAdmin: true }))
      ).toEqual({ code: 'not-yours' });
      for (const stranger of [STRANGER, CAROL]) {
        expect(await refusal(service.calendarLink(id, as(stranger)))).toEqual({
          code: 'not-yours',
        });
      }
      // An id that names nothing reads exactly like someone else's booking.
      expect(await refusal(service.calendarLink(randomUUID(), as(ALICE)))).toEqual({
        code: 'not-yours',
      });
      await service.withdraw(id, as(BOB), NOW);
      expect(await refusal(service.calendarLink(id, as(BOB)))).toEqual({ code: 'not-yours' });
      await service.cancel(id, as(ALICE), NOW);
      expect(await refusal(service.calendarLink(id, as(ALICE)))).toEqual({
        code: 'already-cancelled',
      });
    });

    it('judges answers keyed by the declared questions only: a __proto__ key reaches no map', async () => {
      const items = [{ id: 'q', label: 'Remarque', required: true, type: 'short_text' }];
      const { space, resourceIds } = await setup({ items: items as never });
      // As a JSON body arrives: `__proto__` an OWN key, which a `{}` literal turns into its prototype.
      const answers = JSON.parse('{"q":"oui","__proto__":["x"],"undeclared":"y"}') as Record<
        string,
        string
      >;
      builtAnswers.length = 0;
      const { id } = await service.book(
        space.id,
        { resourceId: resourceIds[0], startsAt: on('10:00'), endsAt: on('10:30'), answers },
        as(ALICE),
        NOW
      );
      const judged = builtAnswers[builtAnswers.length - 1];
      expect(Object.getPrototypeOf(judged)).toBeNull();
      expect(Object.keys(judged)).toEqual(['q']);
      expect(judged.q).toEqual(['oui']);
      const [row] = await q(`SELECT answers FROM bookings WHERE id = $1`, [id]);
      expect(row.answers).toEqual({ q: 'oui' });
    });

    it('serves the .ics on its signature alone, with no answer, private text or name', async () => {
      const items = [{ id: 'cv', label: 'Remarque', required: false, type: 'short_text' }];
      const { space, resourceIds } = await setup({ items: items as never });
      const { id } = await service.book(
        space.id,
        {
          resourceId: resourceIds[0],
          startsAt: on('10:00'),
          endsAt: on('10:30'),
          answers: { cv: 'answer-secret' },
        },
        as(ALICE),
        NOW
      );
      const parts = (path: string) => {
        const params = new URLSearchParams(path.split('?')[1]);
        return [params.get('u') ?? undefined, params.get('sig') ?? undefined] as const;
      };
      const fetchIcs = (bookingId: string, path: string) =>
        service.calendarIcs(bookingId, ...parts(path));
      const { path } = await service.calendarLink(id, as(ALICE));

      const ics = await fetchIcs(id, path);
      expect(ics).toContain('SUMMARY:Salle de musique - Salle 0');
      expect(ics).toContain('DTSTART:20261102T100000Z');
      expect(ics).toContain('DTEND:20261102T103000Z');
      expect(ics).toContain(`/bookings/spaces/${space.id}`);
      for (const secret of ['answer-secret', 'code 1234', 'cle 0', 'Alice']) {
        expect(ics).not.toContain(secret);
      }

      // Another booking's signature, none, a forged one: refused before anything is read.
      const other = await book(space.id, resourceIds[0], '11:00', '11:30', BOB, {});
      const [bob, otherSig] = parts((await service.calendarLink(other.id, as(BOB))).path);
      const [alice, aliceSig] = parts(path);
      for (const [who, bad] of [
        [bob, otherSig],
        [alice, otherSig],
        [bob, aliceSig],
        [alice, undefined],
        [undefined, aliceSig],
        [alice, 'forged'],
      ] as const) {
        expect(await refusal(service.calendarIcs(id, who, bad))).toEqual({
          code: 'calendar-signature',
        });
      }
      // A valid signature for an id that names nothing learns only that.
      const ghost = randomUUID();
      expect(await refusal(fetchIcs(ghost, bookingCalendarPath(ghost, ALICE)))).toEqual({
        code: 'booking-not-found',
      });

      // Rotating the key ends every saved link.
      process.env.AGENDA_SIGNING_KEY = `${KEY}-rotated`;
      try {
        expect(await refusal(fetchIcs(id, path))).toEqual({
          code: 'calendar-signature',
        });
      } finally {
        process.env.AGENDA_SIGNING_KEY = KEY;
      }

      // A cancelled booking's link answers 410: a stale import cannot write it back.
      await service.cancel(id, as(ALICE), NOW);
      expect(await refusal(fetchIcs(id, path))).toEqual({
        code: 'booking-cancelled',
      });
    });

    it('stops a link when its recipient stops being of the booking, or is erased', async () => {
      const ERASED = '9e'.repeat(32);
      await q(`INSERT INTO users (id, "firstName", "lastName") VALUES ($1, 'Gone', 'X')`, [ERASED]);
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await ds.getRepository(BookingResource).update(r, { linkedUserId: DAN });
      const { id } = await book(space.id, r, '10:00', '10:30', ALICE, { participantIds: [BOB] });
      const past = await ds.getRepository(Booking).save({
        resourceId: r,
        holderId: ERASED,
        holderName: 'Gone X',
        bookedById: ERASED,
        startsAt: new Date(on('09:00', '2026-10-01')),
        endsAt: new Date(on('09:30', '2026-10-01')),
      });
      const fetchAs = async (bookingId: string, who: string) => {
        const params = new URLSearchParams(
          (await service.calendarLink(bookingId, as(who))).path.split('?')[1]
        );
        return () =>
          service.calendarIcs(
            bookingId,
            params.get('u') ?? undefined,
            params.get('sig') ?? undefined
          );
      };
      const bobs = await fetchAs(id, BOB);
      const dans = await fetchAs(id, DAN);
      const orgas = await fetchAs(id, ORGA);
      const erased = await fetchAs(past.id, ERASED);
      for (const f of [bobs, dans, orgas, erased]) await expect(f()).resolves.toContain('VEVENT');

      await service.withdraw(id, as(BOB), NOW);
      await ds.getRepository(BookingResource).update(r, { linkedUserId: null });
      grants.delete(`${ORGA}:${space.associationId}`);
      await runErasureStatements(
        {
          write: async (sql, params) => ((await q(sql, params)) as [unknown, number])[1] ?? 0,
          read: async <T>(sql: string, params: unknown[]) => (await q(sql, params)) as T[],
        },
        BOOKINGS_ERASURE_STATEMENTS,
        ERASED
      );
      await q(`DELETE FROM users WHERE id = $1`, [ERASED]);
      for (const f of [bobs, dans, orgas, erased]) {
        expect(await refusal(f())).toEqual({ code: 'calendar-revoked' });
      }
      // The holder's own link is untouched by the others leaving.
      await expect((await fetchAs(id, ALICE))()).resolves.toContain('VEVENT');
    });

    it("names the questions a reader's profile hides, as a form does, and no others", async () => {
      const items = [
        { id: 'all', label: 'Nom', required: true, type: 'short_text' },
        {
          id: 'p24',
          label: 'Promo 2024',
          required: true,
          type: 'short_text',
          showIf: { promo: { values: [2024] } },
        },
        {
          id: 'ans',
          label: 'Suite',
          required: false,
          type: 'short_text',
          showIf: { answer: { questionId: 'all', optionIds: ['x'] } },
        },
      ];
      const { space } = await setup({ items: items as never });
      facts.set(CAROL, { promo: 2024, formation: null, cotisationTiers: [], answers: {} });
      expect((await service.getSpace(space.id, as(ALICE))).hiddenItemIds).toEqual(['p24']);
      expect((await service.getSpace(space.id, as(CAROL))).hiddenItemIds).toEqual([]);
    });

    it('sends a block id only to whoever may lift it', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      await ds.getRepository(BookingResource).update(r, { linkedUserId: DAN });
      const { id: blockId } = await service.addBlock(
        r,
        { startsAt: on('09:00'), endsAt: on('10:00'), reason: 'travaux', reasonVisible: true },
        as(ORGA),
        NOW
      );
      const blockedUnit = async (viewer: string) =>
        (await service.spaceSlots(space.id, '2026-11-02', '2026-11-02', as(viewer)))[0].units.find(
          (u) => u.state === 'blocked'
        )!;
      expect((await blockedUnit(ORGA)).blockId).toBe(blockId);
      expect((await blockedUnit(DAN)).blockId).toBe(blockId);
      const seen = await blockedUnit(ALICE);
      expect(seen).not.toHaveProperty('blockId');
      expect(seen.blockReason).toBe('travaux');
    });
  });

  describe('the organiser (WP-B4)', () => {
    const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      startTime: '08:00',
      endTime: '22:00',
    }));
    const availability = (lines: object[], exceptions: object[] = []) =>
      ({ lines, exceptions }) as never;

    it('creates a personal space for anyone, an entity space for its organiser alone', async () => {
      const association = (
        await q(`INSERT INTO associations (id) VALUES (gen_random_uuid()) RETURNING id`)
      )[0].id as string;
      grants.add(`${ORGA}:${association}`);
      const { id: personal } = await organiser.create({ name: 'Psy' }, as(ALICE));
      expect(
        await refusal(organiser.create({ name: 'BDA', associationId: association }, as(ALICE)))
      ).toEqual({ code: 'not-manager' });
      await organiser.create({ name: 'BDA', associationId: association }, as(ORGA));

      expect((await organiser.managedList(null, as(ALICE))).map((s) => s.id)).toEqual([personal]);
      expect(await organiser.managedList(association, as(ORGA))).toEqual([
        expect.objectContaining({ name: 'BDA', resourceCount: 1 }),
      ]);
      expect(await refusal(organiser.managedList(association, as(ALICE)))).toEqual({
        code: 'not-manager',
      });
      expect(await refusal(organiser.managedSpaceView(personal, as(BOB)))).toEqual({
        code: 'not-manager',
      });
    });

    it('refuses settings the database would refuse, as codes', async () => {
      const { id } = await organiser.create({ name: 'x' }, as(ALICE));
      const patch = (dto: object) => organiser.update(id, dto as never, as(ALICE), NOW);
      expect(await refusal(patch({ timeZone: 'Mars/Olympus' }))).toEqual({ code: 'time-zone' });
      expect(await refusal(patch({ maxMinutesPerPeriod: 60 }))).toEqual({ code: 'quota-pair' });
      // WP-B6 brought the file question's storage and purge: it is accepted now.
      await expect(
        patch({ items: [{ id: 'q', label: 'CV', required: true, type: 'file' }] })
      ).resolves.toEqual({ ok: true });
      await expect(patch({ slotMode: 'slots' })).resolves.toEqual({ ok: true });
      const view = await organiser.managedSpaceView(id, as(ALICE));
      expect([view.slotMode, view.stepMinutes, view.maxSteps]).toEqual(['slots', null, null]);
    });

    describe('the stored slot length (migration 116)', () => {
      it('a slots space is created with it and reads it back; a step space has none', async () => {
        const { id } = await organiser.create(
          { name: 'Alumni', slotMode: 'slots', slotMinutes: 25 } as never,
          as(ALICE)
        );
        const view = await organiser.managedSpaceView(id, as(ALICE));
        expect([view.slotMode, view.stepMinutes, view.maxSteps, view.slotMinutes]).toEqual([
          'slots',
          null,
          null,
          25,
        ]);
        const { id: step } = await organiser.create({ name: 'Salle' }, as(ALICE));
        expect((await organiser.managedSpaceView(step, as(ALICE))).slotMinutes).toBeNull();
      });

      it('the mode switch writes it, and a switch to step clears it', async () => {
        const { id } = await organiser.create({ name: 'x' }, as(ALICE));
        const patch = (dto: object) => organiser.update(id, dto as never, as(ALICE), NOW);
        const read = async () => {
          const v = await organiser.managedSpaceView(id, as(ALICE));
          return [v.slotMode, v.stepMinutes, v.maxSteps, v.slotMinutes];
        };
        await expect(patch({ slotMode: 'slots', slotMinutes: 45 })).resolves.toEqual({ ok: true });
        expect(await read()).toEqual(['slots', null, null, 45]);
        // Unnamed by the body: cleared with the switch, so the CHECK never sees a step space with one.
        await expect(patch({ slotMode: 'step', stepMinutes: 30, maxSteps: 2 })).resolves.toEqual({
          ok: true,
        });
        expect(await read()).toEqual(['step', 30, 2, null]);
        // A slots space may keep NO length: a space created before 116 reads its lines instead.
        await expect(patch({ slotMode: 'slots' })).resolves.toEqual({ ok: true });
        expect(await read()).toEqual(['slots', null, null, null]);
      });

      it('refuses a length on a step space, and one out of range, as slot-shape', async () => {
        expect(
          await refusal(organiser.create({ name: 'x', slotMinutes: 30 } as never, as(ALICE)))
        ).toEqual({ code: 'slot-shape' });
        expect(
          await refusal(
            organiser.create(
              {
                name: 'x',
                slotMode: 'step',
                stepMinutes: 30,
                maxSteps: 2,
                slotMinutes: 30,
              } as never,
              as(ALICE)
            )
          )
        ).toEqual({ code: 'slot-shape' });
        expect(
          await refusal(
            organiser.create({ name: 'x', slotMode: 'slots', slotMinutes: 500 } as never, as(ALICE))
          )
        ).toEqual({ code: 'slot-shape' });
        const { id } = await organiser.create({ name: 'x' }, as(ALICE));
        expect(
          await refusal(organiser.update(id, { slotMinutes: 30 } as never, as(ALICE), NOW))
        ).toEqual({ code: 'slot-shape' });
      });

      it('the CHECK holds the same pair under the service', async () => {
        const repo = ds.getRepository(BookingSpace);
        await expect(
          repo.save({ ownerId: ALICE, name: 'x', stepMinutes: 30, maxSteps: 1, slotMinutes: 30 })
        ).rejects.toThrow(/booking_spaces_slot_minutes/);
        await expect(
          repo.save({ ownerId: ALICE, name: 'x', slotMode: 'slots', slotMinutes: 10 })
        ).rejects.toThrow(/booking_spaces_slot_minutes/);
        const ok = await repo.save({
          ownerId: ALICE,
          name: 'x',
          slotMode: 'slots',
          slotMinutes: 120,
        });
        expect(ok.slotMinutes).toBe(120);
      });
    });

    it('writes availability and reads it back; refuses a malformed line', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      expect(
        await refusal(
          organiser.setAvailability(
            r,
            availability([{ weekday: 1, startTime: '10:00', endTime: '09:00' }]),
            as(ORGA),
            NOW
          )
        )
      ).toEqual({ code: 'line-order' });
      expect(
        await refusal(
          organiser.setAvailability(
            r,
            availability([
              { weekday: 1, onDate: '2026-11-02', startTime: '09:00', endTime: '10:00' },
            ]),
            as(ORGA),
            NOW
          )
        )
      ).toEqual({ code: 'line-kind' });
      await organiser.setAvailability(
        r,
        availability(
          [
            { weekday: 5, startTime: '22:00', endTime: '24:00' },
            { weekday: 6, startTime: '00:00', endTime: '02:00' },
          ],
          [{ fromDate: '2026-12-24', toDate: '2027-01-02' }]
        ),
        as(ORGA),
        NOW
      );
      const view = await organiser.managedSpaceView(space.id, as(ORGA));
      expect(view.resources[0].lines).toEqual(
        expect.arrayContaining([
          { weekday: 5, onDate: null, startTime: '22:00:00', endTime: '24:00:00' },
          { weekday: 6, onDate: null, startTime: '00:00:00', endTime: '02:00:00' },
        ])
      );
      expect(view.resources[0].exceptions).toEqual([
        { fromDate: '2026-12-24', toDate: '2027-01-02' },
      ]);
    });

    it('refuses an availability or a step change over a coming booking, naming it (D29)', async () => {
      const { space, resourceIds } = await setup();
      const r = resourceIds[0];
      const { id } = await book(space.id, r, '10:00', '10:30');
      expect(
        await refusal(
          organiser.setAvailability(
            r,
            availability([{ weekday: 1, startTime: '14:00', endTime: '18:00' }]),
            as(ORGA),
            NOW
          )
        )
      ).toEqual({ code: 'bookings-inside-change', bookingIds: [id] });
      expect(await refusal(organiser.update(space.id, { stepMinutes: 45 }, as(ORGA), NOW))).toEqual(
        {
          code: 'bookings-inside-change',
          bookingIds: [id],
        }
      );
      // Keeping the booking inside: accepted.
      await expect(
        organiser.setAvailability(r, availability(EVERY_DAY), as(ORGA), NOW)
      ).resolves.toEqual({ ok: true });
    });

    it('never deletes a resource that has history, cancelled or past included (D42)', async () => {
      const { space, resourceIds } = await setup({}, 2);
      const [booked, never] = resourceIds;
      const { id } = await book(space.id, booked, '10:00', '10:30');
      expect(await refusal(organiser.removeResource(booked, as(ORGA)))).toEqual({
        code: 'resource-has-bookings',
      });
      // Cancelled is still history (D15): still refused, and the row is still there.
      await service.cancel(id, as(ALICE), NOW);
      expect(await refusal(organiser.removeResource(booked, as(ORGA)))).toEqual({
        code: 'resource-has-bookings',
      });
      expect(await ds.getRepository(Booking).countBy({ id })).toBe(1);
      // A resource nobody ever booked goes.
      await expect(organiser.removeResource(never, as(ORGA))).resolves.toEqual({ ok: true });
    });

    it('a booking racing an availability change: never both', async () => {
      for (let round = 0; round < 5; round++) {
        const { space, resourceIds } = await setup();
        const r = resourceIds[0];
        const [booked, changed] = await Promise.allSettled([
          book(space.id, r, '10:00', '10:30'),
          organiser.setAvailability(
            r,
            availability([{ weekday: 1, startTime: '14:00', endTime: '18:00' }]),
            as(ORGA),
            NOW
          ),
        ]);
        expect([booked.status, changed.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      }
    });

    it('links a resource to an existing account only, and deletes a space with everything', async () => {
      const { space } = await setup();
      expect(
        await refusal(
          organiser.addResource(
            space.id,
            { name: 'Alumni', linkedUserId: '9'.repeat(64) },
            as(ORGA)
          )
        )
      ).toEqual({ code: 'unknown-account' });
      const { id } = await organiser.addResource(
        space.id,
        { name: 'Alumni', linkedUserId: DAN.toUpperCase() },
        as(ORGA)
      );
      expect((await ds.getRepository(BookingResource).findOneByOrFail({ id })).linkedUserId).toBe(
        DAN
      );
      await organiser.remove(space.id, as(ORGA), NOW);
      expect(await ds.getRepository(BookingResource).countBy({ spaceId: space.id })).toBe(0);
    });

    it('refuses duplicate question ids, a zoneless opening, an entity that does not exist', async () => {
      const { id } = await organiser.create({ name: 'x' }, as(ALICE));
      const patch = (dto: object) => organiser.update(id, dto as never, as(ALICE), NOW);
      const q1 = { id: 'q', label: 'Nom', required: false, type: 'text' };
      expect(await refusal(patch({ items: [q1, { ...q1, label: 'Autre' }] }))).toEqual({
        code: 'item-id',
      });
      expect(await refusal(patch({ opensAt: '2026-11-02T10:00:00' }))).toEqual({
        code: 'opens-at',
      });
      await expect(patch({ opensAt: '2026-11-02T10:00:00+01:00' })).resolves.toEqual({ ok: true });
      expect((await organiser.managedSpaceView(id, as(ALICE))).opensAt).toEqual(
        new Date('2026-11-02T09:00:00Z')
      );
      expect(
        await refusal(
          organiser.create(
            { name: 'ghost', associationId: randomUUID() },
            { userId: ALICE, isGlobalAdmin: true }
          )
        )
      ).toEqual({ code: 'association-not-found' });
    });

    it('caps personal spaces per account and resources per space', async () => {
      const owner = RACERS[7];
      for (let i = 0; i < MAX_PERSONAL_SPACES; i++) {
        await organiser.create({ name: `s${i}` }, as(owner));
      }
      expect(await refusal(organiser.create({ name: 'one more' }, as(owner)))).toEqual({
        code: 'too-many-spaces',
        max: MAX_PERSONAL_SPACES,
      });
      const { space } = await setup({}, 0);
      for (let i = 0; i < MAX_RESOURCES_PER_SPACE; i++) {
        await organiser.addResource(space.id, { name: `r${i}` }, as(ORGA));
      }
      expect(
        await refusal(organiser.addResource(space.id, { name: 'one more' }, as(ORGA)))
      ).toEqual({ code: 'too-many-resources', max: MAX_RESOURCES_PER_SPACE });
    });

    describe('the hidden default column (WP-R1, D44)', () => {
      const columnsOf = (spaceId: string) =>
        ds.getRepository(BookingResource).find({ where: { spaceId }, order: { position: 'ASC' } });

      it('creates the space with ONE column named after it, closed when no hours are given', async () => {
        const created = await organiser.create({ name: 'Salle de musique' }, as(ALICE));
        const columns = await columnsOf(created.id);
        expect(columns.map((c) => [c.id, c.name, c.position])).toEqual([
          [created.resourceId, 'Salle de musique', 0],
        ]);
        const view = await organiser.managedSpaceView(created.id, as(ALICE));
        expect(view.resources).toEqual([
          expect.objectContaining({ id: created.resourceId, lines: [], exceptions: [] }),
        ]);
      });

      it('writes the first hours in the same call, and the space is bookable at once', async () => {
        const created = await organiser.create(
          {
            name: 'Atelier',
            timeZone: 'UTC',
            availability: availability(EVERY_DAY, [
              { fromDate: '2026-12-24', toDate: '2026-12-26' },
            ]),
          } as never,
          as(ALICE)
        );
        const view = await organiser.managedSpaceView(created.id, as(ALICE));
        expect(view.resources[0].lines).toHaveLength(7);
        expect(view.resources[0].lines).toEqual(
          expect.arrayContaining([
            { weekday: 1, onDate: null, startTime: '08:00:00', endTime: '22:00:00' },
          ])
        );
        expect(view.resources[0].exceptions).toEqual([
          { fromDate: '2026-12-24', toDate: '2026-12-26' },
        ]);
        await expect(
          service.book(
            created.id,
            { resourceId: created.resourceId, startsAt: on('10:00'), endsAt: on('10:30') } as never,
            as(BOB),
            NOW
          )
        ).resolves.toEqual(expect.objectContaining({ id: expect.any(String) }));
      });

      it('refuses a malformed line before writing anything', async () => {
        expect(
          await refusal(
            organiser.create(
              {
                name: 'Malformed',
                availability: availability([{ weekday: 1, startTime: '10:00', endTime: '09:00' }]),
              } as never,
              as(ALICE)
            )
          )
        ).toEqual({ code: 'line-order' });
        expect(await ds.getRepository(BookingSpace).countBy({ name: 'Malformed' })).toBe(0);
      });

      it('leaves NO space when a write of the column fails inside the transaction', async () => {
        // A weekday the DTO would refuse reaches the database's own CHECK here (the service is
        // called directly): the space and its column were already written, and must roll back.
        await expect(
          organiser.create(
            {
              name: 'Half made',
              availability: availability([{ weekday: 9, startTime: '08:00', endTime: '09:00' }]),
            } as never,
            as(ALICE)
          )
        ).rejects.toThrow(/booking_availability_rules_weekday/);
        expect(await ds.getRepository(BookingSpace).countBy({ name: 'Half made' })).toBe(0);
        expect(await ds.getRepository(BookingResource).countBy({ name: 'Half made' })).toBe(0);
      });

      it('renames the hidden column with its space, and nothing the organiser named', async () => {
        const rename = (id: string, name: string) =>
          organiser.update(id, { name } as never, as(ALICE), NOW);

        const one = await organiser.create({ name: 'Old' }, as(ALICE));
        await rename(one.id, 'New');
        expect((await columnsOf(one.id)).map((c) => c.name)).toEqual(['New']);

        // The only column, but named by the organiser: it keeps its name.
        const named = await organiser.create({ name: 'Room' }, as(ALICE));
        await organiser.updateResource(named.resourceId, { name: 'Piano' }, as(ALICE));
        await rename(named.id, 'Music room');
        expect((await columnsOf(named.id)).map((c) => c.name)).toEqual(['Piano']);
        // Renamed to the space's own name, it becomes the hidden column and follows from then on.
        await organiser.updateResource(named.resourceId, { name: 'Music room' }, as(ALICE));
        await rename(named.id, 'Salle de musique');
        expect((await columnsOf(named.id)).map((c) => c.name)).toEqual(['Salle de musique']);

        // Two columns: the first still bears the former name, and is no longer hidden.
        const two = await organiser.create({ name: 'Alumni' }, as(ALICE));
        await organiser.addResource(two.id, { name: 'Camille', position: 1 }, as(ALICE));
        await rename(two.id, 'Alumni 2026');
        expect((await columnsOf(two.id)).map((c) => c.name)).toEqual(['Alumni', 'Camille']);
      });
    });

    /**
     * THROUGH THE REAL HTTP LAYER, WITH NO ValidationPipe (review of #2006): the whitelist that
     * strips unknown keys in production is not there, so the body reaches the service whole. What
     * stops `ownerId`, `associationId`, `spaceId` or `id` from being written is the service's own
     * list of the keys it copies - and that is what is under test here.
     */
    describe('a body naming fields it may not write (no whitelist)', () => {
      const SECRET = 'bookings-http-it-secret';
      let app: INestApplication;
      let base: string;
      let previousSecret: string | undefined;

      const headersFor = (userId: string) => ({
        'content-type': 'application/json',
        'x-user-id': userId,
        'x-internal-token': createHmac('sha256', SECRET)
          .update(`${userId}:${Math.floor(Date.now() / 60000)}`)
          .digest('hex'),
      });
      const send = (method: string, path: string, body: object) =>
        fetch(`${base}/bookings${path}`, {
          method,
          headers: headersFor(ORGA),
          body: JSON.stringify(body),
        });

      beforeAll(async () => {
        previousSecret = process.env.INTERNAL_SHARED_SECRET;
        process.env.INTERNAL_SHARED_SECRET = SECRET;
        @Module({
          controllers: [BookingSpacesController],
          providers: [{ provide: BookingSpacesService, useValue: organiser }],
        })
        class HttpModule {}
        app = await NestFactory.create(HttpModule, { logger: false });
        await app.listen(0, '127.0.0.1');
        base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      });

      afterAll(async () => {
        await app?.close();
        if (previousSecret === undefined) delete process.env.INTERNAL_SHARED_SECRET;
        else process.env.INTERNAL_SHARED_SECRET = previousSecret;
      });

      it('ignores id, ownerId and associationId on a space, id and spaceId on a resource', async () => {
        const { space, resourceIds } = await setup();
        const other = await setup();
        const res = await send('PATCH', `/spaces/${space.id}`, {
          name: 'Renamed',
          id: randomUUID(),
          ownerId: STRANGER,
          associationId: other.space.associationId,
          createdAt: '2000-01-01T00:00:00Z',
        });
        expect(res.status).toBe(200);
        const row = await ds.getRepository(BookingSpace).findOneByOrFail({ id: space.id });
        expect([row.name, row.ownerId, row.associationId]).toEqual([
          'Renamed',
          CREATOR,
          space.associationId,
        ]);

        const patched = await send('PATCH', `/resources/${resourceIds[0]}`, {
          name: 'Salle B',
          id: randomUUID(),
          spaceId: other.space.id,
        });
        expect(patched.status).toBe(200);
        const r = await ds.getRepository(BookingResource).findOneByOrFail({ id: resourceIds[0] });
        expect([r.name, r.spaceId]).toEqual(['Salle B', space.id]);

        const forgedId = randomUUID();
        const added = await send('POST', `/spaces/${space.id}/resources`, {
          name: 'Salle C',
          id: forgedId,
          spaceId: other.space.id,
        });
        expect(added.status).toBe(201);
        const { id } = (await added.json()) as { id: string };
        expect(id).not.toBe(forgedId);
        expect((await ds.getRepository(BookingResource).findOneByOrFail({ id })).spaceId).toBe(
          space.id
        );

        const created = await send('POST', '/spaces', {
          name: 'Mine',
          ownerId: STRANGER,
          id: forgedId,
        });
        expect(created.status).toBe(201);
        const mine = (await created.json()) as { id: string };
        const createdRow = await ds.getRepository(BookingSpace).findOneByOrFail({ id: mine.id });
        expect([createdRow.id === forgedId, createdRow.ownerId]).toEqual([false, ORGA]);
      });
    });
  });

  describe('the notices and the reminder (WP-N, D53, Q-R1..Q-R7)', () => {
    beforeEach(async () => {
      // The schema is shared with every case above, many on the same morning: their people are
      // marked reminded, so each case here reads only the reminders of its own bookings.
      await q(`UPDATE bookings SET "reminderSentAt" = now() WHERE "reminderSentAt" IS NULL`);
      await q(
        `UPDATE booking_participants SET "reminderSentAt" = now() WHERE "reminderSentAt" IS NULL`
      );
      told.length = 0;
      pushed.length = 0;
      notices.enabled = true;
    });
    afterEach(() => {
      notices.enabled = false;
    });

    const tos = (type: string) =>
      told
        .filter((t) => t.type === type)
        .map((t) => t.to)
        .sort();

    it('OFF, nothing is told and the reminder claims nothing', async () => {
      notices.enabled = false;
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      await service.cancel(id, as(ORGA), NOW);
      expect(told).toEqual([]);
      // The cron's own entry point returns before claiming: nothing is stamped.
      await reminders.remindDue();
      expect((await q(`SELECT "reminderSentAt" FROM bookings WHERE id = $1`, [id]))[0]).toEqual({
        reminderSentAt: null,
      });
    });

    it('a booking tells its participants, and the holder of a booking made on their behalf', async () => {
      const { space, resourceIds } = await setup();
      await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, { participantIds: [BOB] });
      expect(tos('booking_added')).toEqual([BOB]);
      told.length = 0;
      await book(space.id, resourceIds[0], '11:00', '11:30', ORGA, {
        holderId: CAROL,
        participantIds: [DAN],
      });
      expect(tos('booking_added')).toEqual([CAROL, DAN]);
      expect(
        told.every(
          (t) =>
            t.text === t.meta?.place &&
            t.meta.word === '' &&
            t.meta.startsAt === new Date(on('11:00')).toISOString() &&
            t.meta.timeZone === 'UTC'
        )
      ).toBe(true);
    });

    it("the organiser's cancellation tells the holder and the participants still in, with its word", async () => {
      const { space, resourceIds } = await setup();
      await q(`UPDATE associations SET name = 'Club Musique' WHERE id = $1`, [space.associationId]);
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB, RACERS[0]],
      });
      await service.withdraw(id, as(RACERS[0]), NOW);
      told.length = 0;
      await service.cancel(id, as(ORGA), NOW, 'Salle inondee');
      expect(tos('booking_cancelled')).toEqual([ALICE, BOB]);
      // `text` is what it always was (the word, else the place) so an older client still names
      // something; the client of this column reads place, slot, zone and word from `meta`.
      expect(
        told.every(
          (t) =>
            t.text === 'Salle inondee' &&
            t.actorName === 'Club Musique' &&
            typeof t.meta?.place === 'string' &&
            (t.meta.place as string).startsWith(space.name) &&
            t.meta.word === 'Salle inondee' &&
            t.meta.startsAt === new Date(on('10:00')).toISOString() &&
            t.meta.timeZone === 'UTC'
        )
      ).toBe(true);
      // Without a word, `text` is the place (as before this column) and `meta.word` is empty.
      const second = await book(space.id, resourceIds[0], '11:00', '11:30', ALICE);
      told.length = 0;
      await service.cancel(second.id, as(ORGA), NOW);
      expect(told).toHaveLength(1);
      expect(told[0].text.startsWith(space.name)).toBe(true);
      expect(told[0].text).toBe(told[0].meta?.place);
      expect(told[0].meta).toMatchObject({
        word: '',
        startsAt: new Date(on('11:00')).toISOString(),
        timeZone: 'UTC',
      });
    });

    it("the holder's cancellation tells the participants (Q-R2), and carries no word of theirs", async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      told.length = 0;
      await service.cancel(id, as(ALICE), NOW, 'ignored');
      expect(tos('booking_cancelled')).toEqual([BOB]);
      expect(told[0].text).not.toBe('ignored');
      expect(told[0].actorName).toBeUndefined();
    });

    it("a participant's withdrawal tells the holder (Q-R2); the organiser is never told (Q-R7)", async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      told.length = 0;
      await service.withdraw(id, as(BOB), NOW);
      expect(told.map((t) => [t.type, t.to])).toEqual([['booking_withdrawn', ALICE]]);
      expect(told[0].text).toBe(told[0].meta?.place);
      expect(told[0].meta).toMatchObject({
        word: '',
        startsAt: new Date(on('10:00')).toISOString(),
        timeZone: 'UTC',
      });
    });

    it('a space reached by its link only is never named on a lock screen (Q-R5)', async () => {
      const { space, resourceIds } = await setup({ discoverability: 'link' });
      await q(
        `UPDATE associations SET name = 'Cabinet', "logoMediaId" = gen_random_uuid() WHERE id = $1`,
        [space.associationId]
      );
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      expect(pushed.map((t) => t.text)).toEqual(['']);
      await reminders.remindOnce(new Date(on('09:00')));
      expect(pushed.filter((t) => t.type === 'booking_reminder').map((t) => t.text)).toEqual([
        '10:00',
        '10:00',
      ]);
      // ...and its reminder row names no association either (Q-R5).
      expect(told.filter((t) => t.type === 'booking_reminder').map((t) => t.associationId)).toEqual(
        [undefined, undefined]
      );

      // The ORGANISER acts: the push names nobody - no association, no logo, no person - and the
      // organiser's word reaches the bell row only, never the lock screen (Q-R3 on Q-R5).
      told.length = 0;
      pushed.length = 0;
      await service.cancel(id, as(ORGA), NOW, 'Le cabinet est ferme');
      expect(
        pushed
          .map((t) => [
            t.to,
            t.text,
            t.actorName,
            t.actorId,
            t.associationId,
            t.associationLogoMediaId,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).toEqual([ALICE, BOB].map((to) => [to, '', 'Canari', 'system', undefined, undefined]));
      expect(
        told
          .map((t) => [t.to, t.text, t.actorName, t.actorId, t.associationId])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).toEqual(
        [ALICE, BOB].map((to) => [to, 'Le cabinet est ferme', 'Canari', 'system', undefined])
      );
      // The bell row names no place (Q-R5) but still carries the slot.
      expect(told.map((t) => t.meta)).toEqual(
        [ALICE, BOB].map(() => ({
          place: '',
          startsAt: new Date(on('10:00')).toISOString(),
          timeZone: 'UTC',
          word: 'Le cabinet est ferme',
        }))
      );

      // An organiser booking for someone on that space names nobody either.
      pushed.length = 0;
      await book(space.id, resourceIds[0], '12:00', '12:30', ORGA, { holderId: CAROL });
      expect(pushed.map((t) => [t.to, t.actorName, t.actorId, t.associationId])).toEqual([
        [CAROL, 'Canari', 'system', undefined],
      ]);
    });

    it('deleting a space tells the people of its COMING bookings (Q-R4)', async () => {
      const { space, resourceIds } = await setup();
      await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, { participantIds: [BOB] });
      const gone = await book(space.id, resourceIds[0], '11:00', '11:30', CAROL);
      await service.cancel(gone.id, as(CAROL), NOW);
      told.length = 0;
      // The notices go AFTER the response (the delete does not wait on them): await them here.
      const sent = jest.spyOn(notices, 'spaceDeleted');
      await organiser.remove(space.id, as(ORGA), NOW);
      await sent.mock.results[0].value;
      sent.mockRestore();
      expect(tos('booking_cancelled')).toEqual([ALICE, BOB]);
      // The deleted space's SQL (`deletedBookingNotices`) carries the slot too, read before the
      // delete: only the 10:00 booking is coming and live (the 11:00 one was cancelled).
      expect(
        told.every(
          (t) =>
            t.text === t.meta?.place &&
            (t.meta.place as string).startsWith(space.name) &&
            t.meta.word === '' &&
            t.meta.startsAt === new Date(on('10:00')).toISOString() &&
            t.meta.timeZone === 'UTC'
        )
      ).toBe(true);
    });

    it('THE REFERENCE: a reminder run twice sends once, to each person, at its instant', async () => {
      const { space, resourceIds } = await setup();
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      expect(await reminders.remindOnce(new Date(on('08:59')))).toEqual({
        claimed: 0,
        sent: 0,
        failed: 0,
      });
      const [first, second] = await Promise.all([
        reminders.remindOnce(new Date(on('09:00'))),
        reminders.remindOnce(new Date(on('09:00'))),
      ]);
      expect(first.sent + second.sent).toBe(2);
      expect((await reminders.remindOnce(new Date(on('09:30')))).claimed).toBe(0);
      expect(tos('booking_reminder')).toEqual([ALICE, BOB]);
      expect(told.find((t) => t.type === 'booking_reminder')?.text).toContain('10:00');
      expect(told.every((t) => t.bookingId === id)).toBe(true);
      // The row carries the owning association, so the bell draws its logo (owner, 2026-10-30).
      // (`told` also holds the booking's own `booking_added` notice, where the actor is a person.)
      expect(
        told
          .filter((t) => t.type === 'booking_reminder')
          .every((t) => t.associationId === space.associationId)
      ).toBe(true);
    });

    it('no reminder for a cancelled booking, a withdrawn participant, or one made inside its delay (Q-R6)', async () => {
      const { space, resourceIds } = await setup();
      const cancelled = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE);
      await service.cancel(cancelled.id, as(ALICE), NOW);
      const left = await book(space.id, resourceIds[0], '11:00', '11:30', CAROL, {
        participantIds: [BOB],
      });
      await service.withdraw(left.id, as(BOB), NOW);
      // Made at 12:30 for 13:00: its 60-minute reminder instant was already past.
      await book(space.id, resourceIds[0], '13:00', '13:30', DAN, {}, Date.parse(on('12:30')));
      told.length = 0;
      await reminders.remindOnce(new Date(on('10:00')));
      await reminders.remindOnce(new Date(on('12:45')));
      expect(told.map((t) => [t.type, t.to])).toEqual([['booking_reminder', CAROL]]);
    });

    it("each person sets their own delay (Q-R1), and only one of the booking's people may", async () => {
      const { space, resourceIds } = await setup({ reminderMinutes: 120 });
      const { id } = await book(space.id, resourceIds[0], '10:00', '10:30', ALICE, {
        participantIds: [BOB],
      });
      expect(await refusal(service.setReminder(id, 30, as(STRANGER), NOW))).toEqual({
        code: 'not-yours',
      });
      // A participant who LEFT is no longer one of its people.
      const left = await book(space.id, resourceIds[0], '15:00', '15:30', ALICE, {
        participantIds: [RACERS[1]],
      });
      await service.withdraw(left.id, as(RACERS[1]), NOW);
      expect(await refusal(service.setReminder(left.id, 30, as(RACERS[1]), NOW))).toEqual({
        code: 'not-yours',
      });
      await service.setReminder(id, 30, as(ALICE), NOW);
      await service.setReminder(id, null, as(BOB), NOW);
      told.length = 0;
      const mine = await service.mine(as(ALICE));
      expect(mine.find((b) => b.id === id)?.reminderMinutes).toBe(30);
      expect((await service.mine(as(BOB))).find((b) => b.id === id)?.reminderMinutes).toBeNull();
      await reminders.remindOnce(new Date(on('08:00')));
      expect(told).toEqual([]);
      await reminders.remindOnce(new Date(on('09:30')));
      expect(tos('booking_reminder')).toEqual([ALICE]);
      expect(
        await refusal(service.setReminder(id, 30, as(ALICE), Date.parse(on('10:00'))))
      ).toEqual({ code: 'history-frozen' });
    });

    it('migration 115 runs twice without error', async () => {
      const file = readdirSync(MIGRATION_DIR).find((f) => f.startsWith('115_'));
      const sql = readFileSync(join(MIGRATION_DIR, file as string), 'utf8');
      await q(sql);
      await q(sql);
      const [{ n }] = (await q(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%reminder_range'
            AND connamespace = to_regnamespace(current_schema())::oid`
      )) as { n: number }[];
      expect(n).toBe(3);
    });
  });
});
