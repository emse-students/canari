/**
 * THE OPENING REMINDERS (engagement WP-4) against a REAL PostgreSQL: migrations 151 and 152 as they
 * ship, the followers' rows written at publication, "Me prévenir" as an upsert on the same row, the
 * scheduler's claims, the bell, the old image's writes mirrored by 152's trigger, the erasure.
 *
 * What only the database can prove: that the unique key makes a follower who also asked ONE row, so
 * ONE opening push; that the copy keeps every reminder and re-runs clean; that an old image's claim
 * on `form_reminders` and the new image's claim on `opening_reminders` exclude each other in both
 * orders; that two replicas of the scheduler push a row once. The scheduler and the notification
 * service are the REAL ones; only the push transport is a recorder.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- opening-reminders.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { OpeningReminder } from './entities/opening-reminder.entity';
import {
  announceOpeningToFollowers,
  askOpening,
  cancelOpening,
  followOpeningMove,
  isTold,
  PURGE_STALE_OPENINGS_SQL,
} from './opening-reminders';
import { AccountBell } from '../follows/entities/account-bell.entity';
import { AccountBellsService } from '../follows/account-bells.service';
import { FormReminderScheduler } from '../forms/forms-reminder.scheduler';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import {
  createEngagementPushCapTables,
  createPostNotificationsTable,
  givePushDevices,
} from '../posts/post-notifications.it-schema';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import { announceSpaceOpening } from '../bookings/booking-spaces.service';
import type { PushContent } from '../push/push-content';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const BDE = '7a1c2d9e-0000-4000-8000-0000000000b1';
const FORM = '7a1c2d9e-0000-4000-8000-0000000000f1';
const OLD_FORM = '7a1c2d9e-0000-4000-8000-0000000000f2';
const SPACE = '7a1c2d9e-0000-4000-8000-0000000000a1';
const LINK_SPACE = '7a1c2d9e-0000-4000-8000-0000000000a2';
const EVENT = '7a1c2d9e-0000-4000-8000-0000000000e1';
/** In the BDE's audience (ICM, Saint-Etienne). */
const FAN = 'fan';
const FAN_ASKER = 'fan-asker';
const ASKER = 'asker';
const MUTED_FAN = 'muted-fan';
/** Follows the BDE, but its rules do not reach them (Gardanne) and they are no member. */
const FAR_FAN = 'far-fan';
const PUBLISHER = 'publisher';

maybe('opening reminders against PostgreSQL (engagement WP-4)', () => {
  const schema = `openings_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let scheduler: FormReminderScheduler;
  let replica: FormReminderScheduler;
  const pushed: string[] = [];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const push = {
    notifyContent: (to: string, content: PushContent) => {
      pushed.push(`${to}:${content.key}`);
      return Promise.resolve();
    },
  };
  /** `pushed`, sorted: the order of a tick is the order of its query, not a contract. */
  const pushes = () => [...pushed].sort();
  /** An expected list in the order `pushes()` and `rows()` compare in. */
  const sorted = (list: string[]) => [...list].sort();
  const rows = async (): Promise<string[]> =>
    (
      await q(
        `SELECT kind || ':' || "userId" || ':' || origin || ':' || "notified5min" || '/' || "notifiedOnOpen" AS r
           FROM opening_reminders`
      )
    ).rows
      .map((r) => r.r as string)
      .sort();
  const inApp = async (): Promise<string[]> =>
    (await q(`SELECT "recipientId" || ':' || type AS r FROM post_notifications`)).rows
      .map((r) => r.r as string)
      .sort();
  const opensIn = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  /** Moves every row's opening to the past, by the DATABASE's clock - no wall clock asserted. */
  const openNow = () => q(`UPDATE opening_reminders SET "opensAt" = now() - interval '1 second'`);
  const announceForm = (opensAt: Date | null) =>
    announceOpeningToFollowers(ds.manager, {
      kind: 'form',
      targetId: FORM,
      associationId: BDE,
      opensAt,
      actorId: PUBLISHER,
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    // The tables as production has them, from before migrations existed (TypeORM built them).
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, "displayName" varchar, campus varchar,
        cursus jsonb NOT NULL DEFAULT '[]', admin boolean NOT NULL DEFAULT false);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false, "createdBy" varchar(255), "logoUrl" varchar);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid,
        anonymous boolean NOT NULL DEFAULT false, "hiddenByModeration" boolean NOT NULL DEFAULT false,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE association_follows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "followerUserId" varchar(255) NOT NULL, "associationId" uuid NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE forms (id uuid PRIMARY KEY, title varchar NOT NULL, "associationId" uuid,
        "deletedAt" timestamptz, status varchar(16) NOT NULL DEFAULT 'published');
      CREATE TABLE booking_spaces (id uuid PRIMARY KEY, name varchar NOT NULL, "associationId" uuid,
        discoverability varchar(8) NOT NULL DEFAULT 'listed', audience jsonb);
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, title varchar NOT NULL,
        "associationId" uuid NOT NULL, status varchar NOT NULL DEFAULT 'pending');
      -- form_reminders exactly as TypeORM built it on the estates (\\d form_reminders).
      CREATE TABLE form_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "formId" uuid NOT NULL, "userId" varchar(255) NOT NULL, "opensAt" timestamptz NOT NULL,
        "notified5min" boolean NOT NULL DEFAULT false, "notifiedOnOpen" boolean NOT NULL DEFAULT false,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_form_reminders" UNIQUE ("formId", "userId"));
    `);
    await createPostNotificationsTable(q);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '142_account_bells.sql',
    ]) {
      await q(migration(name));
    }
    const icm = JSON.stringify([{ formation: 'ICM' }]);
    for (const [id, campus] of [
      [FAN, 'saint-etienne'],
      [FAN_ASKER, 'saint-etienne'],
      [ASKER, 'saint-etienne'],
      [MUTED_FAN, 'saint-etienne'],
      [FAR_FAN, 'gardanne'],
      [PUBLISHER, 'saint-etienne'],
    ]) {
      await q(`INSERT INTO users (id, "displayName", campus, cursus) VALUES ($1, $1, $2, $3)`, [
        id,
        campus,
        icm,
      ]);
    }
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'BDE', 'bde')`, [BDE]);
    await q(
      `INSERT INTO spaces (formation, campus) VALUES ('ICM', 'saint-etienne') ON CONFLICT DO NOTHING`
    );
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus)
       VALUES ($1, 'ICM', 'saint-etienne')`,
      [BDE]
    );
    await q(
      `INSERT INTO forms (id, title, "associationId") VALUES ($1, 'Gala', $2), ($3, 'Old', $2)`,
      [FORM, BDE, OLD_FORM]
    );
    await q(
      `INSERT INTO booking_spaces (id, name, "associationId", discoverability)
       VALUES ($1, 'Salle de musique', $3, 'listed'), ($2, 'Salle cachée', $3, 'link')`,
      [SPACE, LINK_SPACE, BDE]
    );
    await q(
      `INSERT INTO association_calendar_events (id, title, "associationId", status)
       VALUES ($1, 'Soirée', $2, 'validated')`,
      [EVENT, BDE]
    );

    // THE STATE MIGRATION 152 MEETS: two reminders asked through the old code, one already told.
    await q(
      `INSERT INTO form_reminders ("formId", "userId", "opensAt", "notified5min", "notifiedOnOpen")
       VALUES ($1, $2, now() + interval '1 hour', false, false),
              ($3, $2, now() - interval '1 day', true, true)`,
      [FORM, ASKER, OLD_FORM]
    );
    await q(migration('151_opening_reminders.sql'));
    await q(migration('152_opening_reminders_copy_form_reminders.sql'));
    // An opening is counted by the daily push cap (owner, 2026-11-10).
    await createEngagementPushCapTables((sql) => q(sql));
    await givePushDevices(q, [FAN, FAN_ASKER, MUTED_FAN, FAR_FAN, PUBLISHER, ASKER]);
    // Applied twice, as a re-run of a deploy would: nothing changes.
    await q(migration('151_opening_reminders.sql'));
    await q(migration('152_opening_reminders_copy_form_reminders.sql'));

    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [OpeningReminder, AccountBell, PostNotification],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    const assoRepo = { findBy: () => Promise.resolve([]) };
    const bells = new AccountBellsService(ds.getRepository(AccountBell), assoRepo as never);
    const notifications = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      push as never,
      bells
    );
    const make = () =>
      new FormReminderScheduler(
        ds.getRepository(OpeningReminder),
        push as never,
        notifications,
        {} as never,
        {} as never
      );
    scheduler = make();
    replica = make();
  });

  afterAll(async () => {
    await ds?.destroy();
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('migration 152 copies every form reminder as an ask, its stamps and its id kept', async () => {
    expect(await rows()).toEqual(
      sorted([`form:${ASKER}:asked:false/false`, `form:${ASKER}:asked:true/true`])
    );
    const same = await q(
      `SELECT count(*)::int AS n FROM opening_reminders o JOIN form_reminders r ON r.id = o.id
        WHERE o."targetId" = r."formId" AND o."opensAt" = r."opensAt"`
    );
    expect(same.rows[0].n).toBe(2);
  });

  describe('after the copy', () => {
    beforeEach(async () => {
      pushed.length = 0;
      await q(`DELETE FROM engagement_push_days`);
      await q(`DELETE FROM form_reminders; DELETE FROM opening_reminders;
               DELETE FROM association_follows; DELETE FROM account_bells;
               DELETE FROM post_notifications; DELETE FROM association_members`);
      for (const id of [FAN, FAN_ASKER, MUTED_FAN, FAR_FAN, PUBLISHER]) {
        await q(
          `INSERT INTO association_follows ("followerUserId", "associationId") VALUES ($1, $2)`,
          [id, BDE]
        );
      }
    });

    it('writes the followers who see the association, never the publisher, the far follower or a stranger', async () => {
      expect(await announceForm(opensIn(60))).toBe(3);
      expect(await rows()).toEqual(
        sorted([
          `form:${FAN}:followed:true/false`,
          `form:${FAN_ASKER}:followed:true/false`,
          `form:${MUTED_FAN}:followed:true/false`,
        ])
      );
      // A MEMBER is told wherever they are: the membership door of the visibility predicate.
      await q(`INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`, [
        BDE,
        FAR_FAN,
      ]);
      expect(await announceForm(opensIn(60))).toBe(1);
      // An archived association announces nothing.
      await q(`UPDATE associations SET archived = true`);
      await q(`DELETE FROM opening_reminders`);
      expect(await announceForm(opensIn(60))).toBe(0);
      await q(`UPDATE associations SET archived = false`);
    });

    it('a follower who also asked gets ONE opening push; a follower the opening and no heads-up; a non-follower who asked both', async () => {
      await announceForm(opensIn(3));
      // Asked AFTER the follower row (the upsert) and BEFORE any row (a new ask).
      await askOpening(ds.manager, 'form', FORM, FAN_ASKER, opensIn(3));
      await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(3));
      // A re-announcement (a later move, a retried publication) never overwrites an ask.
      await announceForm(opensIn(3));
      expect(await rows()).toEqual(
        sorted([
          `form:${ASKER}:asked:false/false`,
          `form:${FAN}:followed:true/false`,
          `form:${FAN_ASKER}:asked:false/false`,
          `form:${MUTED_FAN}:followed:true/false`,
        ])
      );

      // Within five minutes: the heads-up goes to the two who asked, and to nobody else.
      await scheduler.checkReminders();
      expect(pushes()).toEqual(
        sorted([`${ASKER}:form_opening_soon`, `${FAN_ASKER}:form_opening_soon`])
      );

      pushed.length = 0;
      await openNow();
      await scheduler.checkReminders();
      await scheduler.checkReminders();
      expect(pushes()).toEqual(
        sorted([
          `${ASKER}:form_open`,
          `${FAN}:form_open`,
          `${FAN_ASKER}:form_open`,
          `${MUTED_FAN}:form_open`,
        ])
      );
      expect(await inApp()).toEqual(
        sorted([
          `${ASKER}:form_reminder`,
          `${ASKER}:form_reminder`,
          `${FAN}:form_reminder`,
          `${FAN_ASKER}:form_reminder`,
          `${FAN_ASKER}:form_reminder`,
          `${MUTED_FAN}:form_reminder`,
        ])
      );
    });

    it("a follower's reduced bell withholds the opening push, never an ask's, and the bell row is still written", async () => {
      await q(
        `INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
         VALUES ($1, 'association', $3, 'none'), ($2, 'association', $3, 'lives')`,
        [MUTED_FAN, FAN_ASKER, BDE]
      );
      await announceForm(null);
      await askOpening(ds.manager, 'form', FORM, FAN_ASKER, opensIn(60));
      await openNow();
      await scheduler.checkReminders();
      expect(pushes()).toEqual(sorted([`${FAN}:form_open`, `${FAN_ASKER}:form_open`]));
      expect(await inApp()).toEqual(
        sorted([`${FAN}:form_reminder`, `${FAN_ASKER}:form_reminder`, `${MUTED_FAN}:form_reminder`])
      );
    });

    it('two replicas running the same tick push each row once', async () => {
      await announceForm(null);
      await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(2));
      await Promise.all([scheduler.checkReminders(), replica.checkReminders()]);
      await openNow();
      await Promise.all([scheduler.checkReminders(), replica.checkReminders()]);
      expect(pushes()).toEqual(
        sorted([
          `${ASKER}:form_open`,
          `${ASKER}:form_opening_soon`,
          `${FAN}:form_open`,
          `${FAN_ASKER}:form_open`,
          `${MUTED_FAN}:form_open`,
        ])
      );
    });

    it('a moved opening carries the untold rows and re-arms an ask, never a told opening', async () => {
      await announceForm(opensIn(2));
      await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(2));
      await scheduler.checkReminders();
      expect(pushes()).toEqual(sorted([`${ASKER}:form_opening_soon`]));
      pushed.length = 0;
      expect(await followOpeningMove(ds.manager, 'form', FORM, opensIn(60))).toBe(4);
      expect(await rows()).toContain(`form:${ASKER}:asked:false/false`);
      expect(await rows()).toContain(`form:${FAN}:followed:true/false`);
      await scheduler.checkReminders();
      expect(pushes()).toEqual(sorted([]));
    });

    it('"Ne plus me prévenir" removes the row, follower or not, and the status reads it', async () => {
      await announceForm(opensIn(60));
      expect(await isTold(ds.manager, 'form', FORM, FAN)).toBe(true);
      await cancelOpening(ds.manager, 'form', FORM, FAN);
      expect(await isTold(ds.manager, 'form', FORM, FAN)).toBe(false);
      await openNow();
      await scheduler.checkReminders();
      expect(pushes()).not.toContain(`${FAN}:form_open`);
    });

    it('a booking space and an event open to their followers, and a gone target is told nothing', async () => {
      for (const [kind, targetId] of [
        ['booking', SPACE],
        ['event', EVENT],
      ] as const) {
        await announceOpeningToFollowers(ds.manager, {
          kind,
          targetId,
          associationId: BDE,
          opensAt: null,
          actorId: PUBLISHER,
        });
      }
      // A form the association archived before its opening: claimed, told nothing.
      await askOpening(ds.manager, 'form', OLD_FORM, ASKER, opensIn(60));
      await q(`UPDATE forms SET "deletedAt" = now() WHERE id = $1`, [OLD_FORM]);
      await openNow();
      await scheduler.checkReminders();
      expect(pushes()).toEqual(
        sorted([
          `${FAN}:social_booking_open`,
          `${FAN}:social_event_open`,
          `${FAN_ASKER}:social_booking_open`,
          `${FAN_ASKER}:social_event_open`,
          `${MUTED_FAN}:social_booking_open`,
          `${MUTED_FAN}:social_event_open`,
        ])
      );
      const told = await q(
        `SELECT count(*)::int AS n FROM opening_reminders WHERE NOT "notifiedOnOpen"`
      );
      expect(told.rows[0].n).toBe(0);
      const bell = await q(
        `SELECT DISTINCT type, text, "actorName" FROM post_notifications ORDER BY type`
      );
      expect(bell.rows).toEqual([
        { type: 'booking_open', text: 'Salle de musique', actorName: 'BDE' },
        { type: 'event_open', text: 'Soirée', actorName: 'BDE' },
      ]);
    });

    describe('what the review of #3188 found', () => {
      const SPACE_WITH_AUDIENCE = '7a1c2d9e-0000-4000-8000-0000000000a3';
      beforeAll(async () => {
        await q(
          `INSERT INTO booking_spaces (id, name, "associationId", discoverability, audience)
           VALUES ($1, 'Salle des ICM 2A', $2, 'listed', '{"formations": ["ICM"]}')`,
          [SPACE_WITH_AUDIENCE, BDE]
        );
      });
      afterEach(async () => {
        await q(`UPDATE associations SET archived = false`);
        await q(`UPDATE association_calendar_events SET status = 'validated'`);
        await q(`UPDATE users SET campus = 'saint-etienne' WHERE id = $1`, [FAN_ASKER]);
      });

      it('(1) a booking space with an audience names itself to no follower, written or not (L25)', async () => {
        const space = {
          id: SPACE_WITH_AUDIENCE,
          associationId: BDE,
          opensAt: null,
          discoverability: 'listed' as const,
          audience: { formations: ['ICM'] } as never,
        };
        await announceSpaceOpening(ds.manager, space, PUBLISHER);
        expect(await rows()).toEqual([]);
        // A row written before the audience was set: claimed at the opening, told nothing.
        await announceOpeningToFollowers(ds.manager, {
          kind: 'booking',
          targetId: SPACE_WITH_AUDIENCE,
          associationId: BDE,
          opensAt: null,
          actorId: PUBLISHER,
        });
        // The rows open at the DATABASE's now(), in microseconds; the tick compares a JS Date, in
        // milliseconds - moved to the past by the database's clock, as every other test does.
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([]);
        expect(await inApp()).toEqual([]);
        expect(await rows()).toEqual(
          sorted([
            `booking:${FAN}:followed:true/true`,
            `booking:${FAN_ASKER}:followed:true/true`,
            `booking:${MUTED_FAN}:followed:true/true`,
          ])
        );
      });

      it('(2) a follower who unfollowed, left the association or moved campus is not told', async () => {
        await q(`INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`, [
          BDE,
          FAR_FAN,
        ]);
        expect(await announceForm(opensIn(60))).toBe(4);
        await q(`DELETE FROM association_follows WHERE "followerUserId" = $1`, [FAN]);
        await q(`DELETE FROM association_members WHERE "userId" = $1`, [FAR_FAN]);
        await q(`UPDATE users SET campus = 'gardanne' WHERE id = $1`, [FAN_ASKER]);
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([`${MUTED_FAN}:form_open`]);
        expect(await inApp()).toEqual([`${MUTED_FAN}:form_reminder`]);
        // Decided at the opening, once: every row claimed.
        const left = await q(
          `SELECT count(*)::int AS n FROM opening_reminders WHERE NOT "notifiedOnOpen"`
        );
        expect(left.rows[0].n).toBe(0);
      });

      it('(3) a re-ask after an opening was told, the opening moved ahead, is told again', async () => {
        await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(60));
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([`${ASKER}:form_open`]);
        pushed.length = 0;
        expect(await followOpeningMove(ds.manager, 'form', FORM, opensIn(3))).toBe(0);
        await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(3));
        expect(await rows()).toEqual([`form:${ASKER}:asked:false/false`]);
        await scheduler.checkReminders();
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual(sorted([`${ASKER}:form_opening_soon`, `${ASKER}:form_open`]));
        // The OLD image's re-ask (its upsert sets both flags false) re-arms the new row the same way.
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt", "notified5min", "notifiedOnOpen")
           VALUES ($1, $2, now() + interval '1 hour', false, false)`,
          [FORM, ASKER]
        );
        expect(await rows()).toEqual([`form:${ASKER}:asked:false/false`]);
      });

      it('(4) an event sent back to pending is left for later, and told once validated again', async () => {
        await announceOpeningToFollowers(ds.manager, {
          kind: 'event',
          targetId: EVENT,
          associationId: BDE,
          opensAt: null,
          actorId: PUBLISHER,
        });
        await q(`UPDATE association_calendar_events SET status = 'pending'`);
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([]);
        expect(await rows()).toContain(`event:${FAN}:followed:true/false`);
        await q(`UPDATE association_calendar_events SET status = 'validated'`);
        await scheduler.checkReminders();
        expect(pushes()).toEqual(
          sorted([
            `${FAN}:social_event_open`,
            `${FAN_ASKER}:social_event_open`,
            `${MUTED_FAN}:social_event_open`,
          ])
        );
      });

      it('(5) an archived association pushes nothing, a follower row or an ask', async () => {
        await announceOpeningToFollowers(ds.manager, {
          kind: 'booking',
          targetId: SPACE,
          associationId: BDE,
          opensAt: null,
          actorId: PUBLISHER,
        });
        await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(60));
        await q(`UPDATE associations SET archived = true`);
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([]);
        expect(await inApp()).toEqual([]);
        const left = await q(
          `SELECT count(*)::int AS n FROM opening_reminders WHERE NOT "notifiedOnOpen"`
        );
        expect(left.rows[0].n).toBe(0);
      });
    });

    describe('what the second review of #3188 found', () => {
      afterEach(async () => {
        await q(`UPDATE associations SET archived = false`);
      });

      it('(6) an archived association sends no heads-up either: claimed, told nothing', async () => {
        await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(3));
        await q(`UPDATE associations SET archived = true`);
        await scheduler.checkReminders();
        expect(pushes()).toEqual([]);
        expect(await inApp()).toEqual([]);
        expect(await rows()).toEqual([`form:${ASKER}:asked:true/false`]);
      });

      it('(7) an old image never claims a new row whose opening is still to come', async () => {
        // The old image's row says "due now"; the new code moved the opening an hour ahead.
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt") VALUES ($1, $2, now() - interval '1 second')`,
          [FORM, ASKER]
        );
        await followOpeningMove(ds.manager, 'form', FORM, opensIn(60));
        const opening = await q(
          `UPDATE form_reminders SET "notifiedOnOpen" = true WHERE "userId" = $1 AND NOT "notifiedOnOpen"`,
          [ASKER]
        );
        expect(opening.rowCount).toBe(0);
        const headsUp = await q(
          `UPDATE form_reminders SET "notified5min" = true WHERE "userId" = $1 AND NOT "notified5min"`,
          [ASKER]
        );
        expect(headsUp.rowCount).toBe(0);
        expect(await rows()).toEqual([`form:${ASKER}:asked:false/false`]);
        // Inside the five minutes, the old image's heads-up claim is honoured - once.
        await q(`UPDATE opening_reminders SET "opensAt" = now() + interval '2 minutes'`);
        const due = await q(
          `UPDATE form_reminders SET "notified5min" = true WHERE "userId" = $1 AND NOT "notified5min"`,
          [ASKER]
        );
        expect(due.rowCount).toBe(1);
        expect(await rows()).toEqual([`form:${ASKER}:asked:true/false`]);
      });

      it('(9) an old image never claims a heads-up after the new image told the opening', async () => {
        // The old row still says "opens in three minutes"; the organiser moved the opening to now.
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt") VALUES ($1, $2, now() + interval '3 minutes')`,
          [FORM, ASKER]
        );
        await followOpeningMove(ds.manager, 'form', FORM, null);
        await openNow();
        await scheduler.checkReminders();
        expect(pushes()).toEqual([`${ASKER}:form_open`]);
        const late = await q(
          `UPDATE form_reminders SET "notified5min" = true WHERE "userId" = $1 AND NOT "notified5min"`,
          [ASKER]
        );
        expect(late.rowCount).toBe(0);
      });

      it('(10) a draft form owes no heads-up yet, and is told once when it goes live within the window', async () => {
        await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(3));
        await q(`UPDATE forms SET status = 'draft' WHERE id = $1`, [FORM]);
        try {
          await scheduler.checkReminders();
          expect(pushes()).toEqual([]);
          expect(await rows()).toEqual([`form:${ASKER}:asked:false/false`]);
          await q(`UPDATE forms SET status = 'published' WHERE id = $1`, [FORM]);
          await scheduler.checkReminders();
          await scheduler.checkReminders();
          expect(pushes()).toEqual([`${ASKER}:form_opening_soon`]);
        } finally {
          await q(`UPDATE forms SET status = 'published' WHERE id = $1`, [FORM]);
        }
      });

      it('(8) the purge says how many told and never-told rows it removed', async () => {
        await q(
          `INSERT INTO opening_reminders (kind, "targetId", "userId", "opensAt", origin, "notifiedOnOpen")
           VALUES ('form', $1, $2, now() - interval '40 days', 'asked', true),
                  ('form', $1, $3, now() - interval '40 days', 'followed', false),
                  ('form', $1, $4, now() - interval '1 day', 'asked', true)`,
          [FORM, ASKER, FAN, FAN_ASKER]
        );
        const purged = await q(PURGE_STALE_OPENINGS_SQL, [30]);
        expect(purged.rows).toEqual([{ told: 1, untold: 1 }]);
        expect(await rows()).toEqual([`form:${FAN_ASKER}:asked:false/true`]);
      });
    });

    describe('an image older than WP-4, still writing form_reminders during the rollover', () => {
      it('its ask (insert, then its upsert) and its unsubscribe are the same writes on the new store', async () => {
        await announceForm(opensIn(60));
        // The old subscribe of a FOLLOWER: their row becomes an ask, its heads-up armed.
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt") VALUES ($1, $2, now() + interval '1 hour')`,
          [FORM, FAN]
        );
        expect(await rows()).toContain(`form:${FAN}:asked:false/false`);
        // TypeORM's upsert of an existing reminder, as the old `subscribeReminder` sends it.
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt", "notified5min", "notifiedOnOpen")
           VALUES ($1, $2, now() + interval '2 hours', false, false)
           ON CONFLICT ("formId", "userId") DO UPDATE SET "opensAt" = EXCLUDED."opensAt",
             "notified5min" = EXCLUDED."notified5min", "notifiedOnOpen" = EXCLUDED."notifiedOnOpen"`,
          [FORM, FAN]
        );
        const moved = await q(
          `SELECT ("opensAt" > now() + interval '90 minutes') AS later FROM opening_reminders
            WHERE "userId" = $1`,
          [FAN]
        );
        expect(moved.rows[0].later).toBe(true);
        await q(`DELETE FROM form_reminders WHERE "userId" = $1`, [FAN]);
        expect(await isTold(ds.manager, 'form', FORM, FAN)).toBe(false);
      });

      it('its claim and the new claim exclude each other, in both orders', async () => {
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt") VALUES ($1, $2, now() - interval '1 second')`,
          [FORM, ASKER]
        );
        // The OLD image claims first (its conditional update matches): the new one finds it stamped.
        const old = await q(
          `UPDATE form_reminders SET "notifiedOnOpen" = true WHERE "userId" = $1 AND NOT "notifiedOnOpen"`,
          [ASKER]
        );
        expect(old.rowCount).toBe(1);
        await scheduler.checkReminders();
        expect(pushes()).toEqual(sorted([]));

        // The NEW image claims first: the old image's claim is cancelled, it reads affected = 0.
        await q(`DELETE FROM form_reminders; DELETE FROM opening_reminders`);
        await q(
          `INSERT INTO form_reminders ("formId", "userId", "opensAt") VALUES ($1, $2, now() - interval '1 second')`,
          [FORM, ASKER]
        );
        await scheduler.checkReminders();
        expect(pushes()).toEqual(sorted([`${ASKER}:form_open`]));
        const late = await q(
          `UPDATE form_reminders SET "notifiedOnOpen" = true WHERE "userId" = $1 AND NOT "notifiedOnOpen"`,
          [ASKER]
        );
        expect(late.rowCount).toBe(0);
      });
    });

    it('the erasure deletes the account rows of both stores', async () => {
      await announceForm(opensIn(60));
      await askOpening(ds.manager, 'form', FORM, ASKER, opensIn(60));
      for (const label of ['form_reminders', 'opening_reminders']) {
        const statement = ERASURE_STATEMENTS.find((s) => s.label === label);
        expect(statement).toBeDefined();
        await q(statement!.sql, [FAN]);
      }
      expect(await rows()).toEqual(
        sorted([
          `form:${ASKER}:asked:false/false`,
          `form:${FAN_ASKER}:followed:true/false`,
          `form:${MUTED_FAN}:followed:true/false`,
        ])
      );
    });
  });
});
