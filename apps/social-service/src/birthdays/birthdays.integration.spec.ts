/**
 * BIRTHDAYS ON PROFILES against a REAL PostgreSQL (owner, 2026-11-08; docs/wiki/birthdays.md):
 * migration 148 as it ships, the visibility rule every reader of a date asks, the ring of the day,
 * 29 February in a common and a leap year, and the morning notice - who is told, once per day, from
 * the claim, and the bell row that follows the date's visibility afterwards.
 *
 * What only the database can prove: the CHECKs refuse a date no calendar has, the predicate admits
 * exactly the viewers the decision names (block, cohort, pending request included), the claim makes
 * a second tick and a concurrent one announce nothing, and the Paris date of `PARIS_TODAY_SQL`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- birthdays.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { createPostNotificationsTable } from '../posts/post-notifications.it-schema';
import { AccountBell } from '../follows/entities/account-bell.entity';
import { AccountBellsService } from '../follows/account-bells.service';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import { REVIEW_COHORT_ENV } from '../review-cohort';
import type { PushContent } from '../push/push-content';
import {
  BIRTHDAY_BODY_INVALID,
  BIRTHDAY_CHANGE_TOO_SOON,
  BirthdaysService,
} from './birthdays.service';
import { BirthdayNotifier } from './birthday-notifier.scheduler';
import { BIRTHDAY_NOTIFICATION } from './birthday-notification';
import { BIRTHDAY_DATE_INVALID } from './birthday-date';
import { PROFILE_FIELD_VISIBILITY_INVALID } from './profile-field-visibility';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

/**
 * The cast: `ann` is the celebrant; `fol` an accepted follower; `pen` asked and was not answered;
 * `oth` a member who does not follow her; `blk` an accepted follower she blocked; `rev` a review
 * account that follows her (a row left from before the cohort rule).
 */
const PEOPLE = ['ann', 'fol', 'pen', 'oth', 'blk', 'rev', 'leap'];

/** What a refusal carries: the typed code, read from the exception, never its message. */
const codeOf = (e: unknown): unknown =>
  (e as { getResponse?: () => { code?: string } }).getResponse?.().code;

/** The typed code a promise is refused with, or `'resolved'`. */
const refusalOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (e: unknown) => codeOf(e)
  );

maybe('birthdays against PostgreSQL (migration 148)', () => {
  const schema = `bday_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let birthdays: BirthdaysService;
  let notifier: BirthdayNotifier;
  let notifications: PostNotificationsService;
  let bells: AccountBellsService;
  const pushed: string[] = [];
  const previousCohort = process.env[REVIEW_COHORT_ENV];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const push = {
    notifyContent: (to: string, content: PushContent) => {
      pushed.push(`${to}:${content.key}:${content.actorName}`);
      return Promise.resolve();
    },
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const follow = (a: string, b: string, status: 'accepted' | 'pending') =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), $1, $2, $3::varchar, CASE WHEN $3::varchar = 'accepted' THEN now() END)`,
      [a, b, status]
    );
  /** Who `viewer` sees the date of `owner` as, in the profile route's own statement. */
  const dateSeenBy = async (viewer: string, owner = 'ann') =>
    (await birthdays.ofUser(viewer, owner)).birthday;
  const birthdayRows = async (): Promise<string[]> =>
    (
      await q(
        `SELECT "recipientId" || '<' || "actorId" AS r FROM post_notifications
          WHERE type = $1 ORDER BY 1`,
        [BIRTHDAY_NOTIFICATION]
      )
    ).rows.map((r) => r.r as string);

  beforeAll(async () => {
    process.env[REVIEW_COHORT_ENV] = 'rev';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    // The tables as production has them, from before migrations existed (TypeORM built them).
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, "displayName" varchar, "firstName" varchar,
        "lastName" varchar, admin boolean NOT NULL DEFAULT false, campus varchar(32),
        cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false, "createdBy" varchar(255));
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid,
        "studentsOnly" boolean NOT NULL DEFAULT false, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerUserId", "followedUserId"));
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
    `);
    await createPostNotificationsTable(q);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '114_user_follow_status.sql',
      '132_read_grant_readers.sql',
      '121_member_reposts.sql',
      '142_account_bells.sql',
      '148_profile_birthdays.sql',
      // Applied twice, as a re-run of a deploy would: nothing changes, nothing fails.
      '148_profile_birthdays.sql',
    ]) {
      await q(migration(name));
    }
    for (const id of PEOPLE) {
      await q(`INSERT INTO users (id, "displayName") VALUES ($1, $2)`, [id, id.toUpperCase()]);
    }
    await follow('fol', 'ann', 'accepted');
    await follow('pen', 'ann', 'pending');
    await follow('blk', 'ann', 'accepted');
    await follow('rev', 'ann', 'accepted');
    await follow('fol', 'leap', 'accepted');
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('ann', 'blk')`);

    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PostNotification, AccountBell],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    bells = new AccountBellsService(ds.getRepository(AccountBell), {} as never);
    notifications = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      push as never,
      bells
    );
    birthdays = new BirthdaysService(ds);
    notifier = new BirthdayNotifier(ds, notifications);
  });

  afterAll(async () => {
    process.env[REVIEW_COHORT_ENV] = previousCohort;
    await ds?.destroy();
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  // Every case starts with no change window open and nobody announced: the 30-day and 300-day
  // rules are proven by the cases that name them, and the others move dates freely.
  beforeEach(async () => {
    pushed.length = 0;
    await q(`DELETE FROM birthday_changes`);
    await q(`UPDATE profile_birthdays SET "lastAnnouncedOn" = NULL`);
  });
  /** `setMine` with the change window closed first - for the cases about something else. */
  const setFree = async (user: string, body: Record<string, unknown>) => {
    await q(`DELETE FROM birthday_changes WHERE "userId" = $1`, [user]);
    return birthdays.setMine(user, body);
  };
  /** As if the date had been set before today began (Paris): it is in effect today. */
  const setYesterday = (user = 'ann') =>
    q(`UPDATE profile_birthdays SET "dateSetAt" = now() - interval '1 day' WHERE "userId" = $1`, [
      user,
    ]);
  const parisToday = async () => {
    const [{ m, d, today }] = (
      await q(
        `SELECT EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Paris')::date)::int AS m,
                EXTRACT(DAY FROM (now() AT TIME ZONE 'Europe/Paris')::date)::int AS d,
                to_char((now() AT TIME ZONE 'Europe/Paris')::date, 'YYYY-MM-DD') AS today`
      )
    ).rows as Array<{ m: number; d: number; today: string }>;
    return { m, d, today };
  };

  it('starts empty: no account has a birthday, so nobody has a ring or a notice', async () => {
    expect((await q(`SELECT count(*)::int AS n FROM profile_birthdays`)).rows[0].n).toBe(0);
    expect(await birthdays.mine('ann')).toBeNull();
    expect(await birthdays.ofUser('fol', 'ann')).toEqual({ birthday: null, today: false });
    expect(await birthdays.state('ann')).toEqual({ birthday: null, changeOpensOn: null });
    expect((await birthdays.today('fol')).userIds).toEqual([]);
  });

  it('refuses a date no calendar has, in the service and in the table', async () => {
    for (const [month, day] of [
      [4, 31],
      [2, 30],
      [13, 1],
      [0, 10],
      [6, 0],
      [3.5, 2],
    ]) {
      expect(await refusalOf(birthdays.setMine('ann', { month, day }))).toBe(BIRTHDAY_DATE_INVALID);
    }
    expect(
      await refusalOf(birthdays.setMine('ann', { month: 3, day: 14, visibility: 'everyone' }))
    ).toBe(PROFILE_FIELD_VISIBILITY_INVALID);
    expect(await refusalOf(birthdays.setMine('ann', null))).toBe(BIRTHDAY_BODY_INVALID);
    await expect(
      q(`INSERT INTO profile_birthdays ("userId", month, day) VALUES ('x', 4, 31)`)
    ).rejects.toThrow(/CHK_profile_birthdays_calendar/);
    expect(await birthdays.mine('ann')).toBeNull();
  });

  it('stores day and month with FOLLOWERS by default, and keeps the visibility on a date-only edit', async () => {
    expect((await setFree('ann', { month: 3, day: 14 })).birthday).toEqual({
      month: 3,
      day: 14,
      visibility: 'followers',
    });
    await birthdays.setMine('ann', { month: 3, day: 14, visibility: 'school' });
    expect((await setFree('ann', { month: 3, day: 15 })).birthday).toEqual({
      month: 3,
      day: 15,
      visibility: 'school',
    });
    // No year anywhere: the table has no column that could hold one.
    const columns = (
      await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'profile_birthdays' ORDER BY 1`,
        [schema]
      )
    ).rows.map((r) => r.column_name as string);
    expect(columns).toEqual([
      'dateSetAt',
      'day',
      'lastAnnouncedOn',
      'month',
      'updatedAt',
      'userId',
      'visibility',
    ]);
  });

  it('shows the date to exactly the viewers its visibility names', async () => {
    const date = { month: 3, day: 15 };
    await setFree('ann', { ...date, visibility: 'school' });
    expect(await dateSeenBy('ann')).toEqual(date);
    expect(await dateSeenBy('fol')).toEqual(date);
    expect(await dateSeenBy('pen')).toEqual(date);
    expect(await dateSeenBy('oth')).toEqual(date);
    expect(await dateSeenBy('blk')).toBeNull(); // a block, whatever the choice
    expect(await dateSeenBy('rev')).toBeNull(); // across the review cohort's boundary

    await birthdays.setMine('ann', { ...date, visibility: 'followers' });
    expect(await dateSeenBy('ann')).toEqual(date);
    expect(await dateSeenBy('fol')).toEqual(date);
    expect(await dateSeenBy('pen')).toBeNull(); // a request nobody answered opens nothing
    expect(await dateSeenBy('oth')).toBeNull();
    expect(await dateSeenBy('blk')).toBeNull();
    expect(await dateSeenBy('rev')).toBeNull();

    await birthdays.setMine('ann', { ...date, visibility: 'nobody' });
    expect(await dateSeenBy('ann')).toEqual(date);
    for (const viewer of ['fol', 'pen', 'oth', 'blk', 'rev']) {
      expect(await dateSeenBy(viewer)).toBeNull();
    }
  });

  it('draws the ring for everybody on the day whatever the visibility, and on no other day', async () => {
    const { m, d } = await parisToday();
    await setFree('ann', { month: m, day: d, visibility: 'nobody' });
    await setYesterday();
    for (const viewer of ['ann', 'fol', 'pen', 'oth']) {
      expect(await birthdays.ofUser(viewer, 'ann')).toEqual({
        birthday: viewer === 'ann' ? { month: m, day: d } : null,
        today: true,
      });
      expect((await birthdays.today(viewer)).userIds).toEqual(['ann']);
    }
    // Never to the person she blocked, never across the cohort's boundary.
    expect((await birthdays.ofUser('blk', 'ann')).today).toBe(false);
    expect((await birthdays.today('blk')).userIds).toEqual([]);
    expect((await birthdays.today('rev')).userIds).toEqual([]);
    // The date the server answered is its own Paris date.
    const today = await birthdays.today('oth');
    expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Another day: no ring. (A day that is never today: the 1st of next month or the 2nd.)
    await setFree('ann', { month: m, day: d === 1 ? 2 : 1 });
    await setYesterday();
    expect((await birthdays.ofUser('oth', 'ann')).today).toBe(false);
    expect((await birthdays.today('oth')).userIds).toEqual([]);
  });

  it('celebrates a 29 February on the 28th of a common year, and on the 29th of a leap year', async () => {
    await q(`DELETE FROM profile_birthdays`);
    await birthdays.setMine('leap', { month: 2, day: 29, visibility: 'followers' });
    // Shown as entered: the 29th.
    expect(await dateSeenBy('fol', 'leap')).toEqual({ month: 2, day: 29 });

    // 2027 has no 29 February: the 28th celebrates it, the 1 March does not.
    expect((await notifier.announceDue({ today: '2027-02-27', hour: 9 })).claimed).toBe(0);
    expect((await notifier.announceDue({ today: '2027-02-28', hour: 9 })).claimed).toBe(1);
    expect((await notifier.announceDue({ today: '2027-03-01', hour: 9 })).claimed).toBe(0);
    // 2028 has one: the 28th is an ordinary day, the 29th is the birthday.
    expect((await notifier.announceDue({ today: '2028-02-28', hour: 9 })).claimed).toBe(0);
    expect((await notifier.announceDue({ today: '2028-02-29', hour: 9 })).claimed).toBe(1);
    // 2100 is not a leap year (divisible by 100, not 400): the 28th again.
    expect((await notifier.announceDue({ today: '2100-02-28', hour: 9 })).claimed).toBe(1);
    expect(
      (
        await q(
          `SELECT to_char("lastAnnouncedOn", 'YYYY-MM-DD') AS d FROM profile_birthdays
            WHERE "userId" = 'leap'`
        )
      ).rows.map((r) => r.d)
    ).toEqual(['2100-02-28']);
  });

  it('tells, from the morning, the accepted followers who may read the date - once per day', async () => {
    await q(`DELETE FROM profile_birthdays`);
    await q(`DELETE FROM post_notifications`);
    await birthdays.setMine('ann', { month: 6, day: 21, visibility: 'school' });

    // Before 8 in Paris: nothing, and nothing claimed.
    expect(await notifier.announceDue({ today: '2027-06-21', hour: 7 })).toMatchObject({
      due: 0,
      claimed: 0,
    });
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM profile_birthdays WHERE "lastAnnouncedOn" IS NOT NULL`
        )
      ).rows[0].n
    ).toBe(0);

    const first = await notifier.announceDue({ today: '2027-06-21', hour: 8 });
    expect(first).toMatchObject({ due: 1, claimed: 1, told: 1, failed: 0 });
    await flush();
    // `fol` only: `pen` never accepted, `oth` does not follow (school visibility reaches the date,
    // never the notice), `blk` is blocked, `rev` stands across the cohort's boundary.
    expect(await birthdayRows()).toEqual(['fol<ann']);
    expect(pushed).toEqual(['fol:social_birthday:ANN']);

    // Every later tick of the day, and a concurrent pair, find the claim and do nothing.
    pushed.length = 0;
    const again = await Promise.all([
      notifier.announceDue({ today: '2027-06-21', hour: 9 }),
      notifier.announceDue({ today: '2027-06-21', hour: 9 }),
      notifier.announceDue({ today: '2027-06-21', hour: 23 }),
    ]);
    expect(again.map((t) => t.claimed)).toEqual([0, 0, 0]);
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann']);
    expect(pushed).toEqual([]);

    // Two racing ticks on the NEXT year's day: one claim, one row, one push.
    const race = await Promise.all([
      notifier.announceDue({ today: '2028-06-21', hour: 10 }),
      notifier.announceDue({ today: '2028-06-21', hour: 10 }),
    ]);
    expect(race[0].claimed + race[1].claimed).toBe(1);
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann', 'fol<ann']);
    expect(pushed).toEqual(['fol:social_birthday:ANN']);
  });

  it('tells nobody when the date is hidden, and the bell is withheld by a bell on the person', async () => {
    await q(`DELETE FROM post_notifications`);
    await setFree('ann', { month: 7, day: 1, visibility: 'nobody' });
    expect(await notifier.announceDue({ today: '2027-07-01', hour: 9 })).toMatchObject({
      claimed: 1,
      told: 0,
    });
    expect(await birthdayRows()).toEqual([]);

    // A follower who set ann's bell to "Rien": the row is written, the push is not.
    await setFree('ann', { month: 7, day: 2, visibility: 'followers' });
    await q(`UPDATE profile_birthdays SET "lastAnnouncedOn" = NULL`);
    await q(
      `INSERT INTO account_bells ("userId", "targetKind", "targetId", level) VALUES ('fol', 'user', 'ann', 'none')`
    );
    await notifier.announceDue({ today: '2027-07-02', hour: 9 });
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann']);
    expect(pushed).toEqual([]);
    await q(`DELETE FROM account_bells`);
  });

  it('keeps the bell row only while its reader may still read the date', async () => {
    await q(`DELETE FROM post_notifications`);
    await setFree('ann', { month: 8, day: 1, visibility: 'followers' });
    await notifier.announceDue({ today: '2027-08-01', hour: 9 });
    const bellOf = async (reader: string) =>
      (await notifications.bellPageQuery(reader, 30).getMany())
        .filter((n) => n.type === BIRTHDAY_NOTIFICATION)
        .map((n) => n.actorId);
    expect(await bellOf('fol')).toEqual(['ann']);

    await birthdays.setMine('ann', { month: 8, day: 1, visibility: 'nobody' });
    expect(await bellOf('fol')).toEqual([]);
    await birthdays.setMine('ann', { month: 8, day: 1, visibility: 'followers' });
    expect(await bellOf('fol')).toEqual(['ann']);
    await birthdays.clearMine('ann');
    expect(await bellOf('fol')).toEqual([]);
  });

  it('the account erasure removes the date, its notices and the rows naming the member', async () => {
    await setFree('ann', { month: 9, day: 9 });
    expect(
      (await q(`SELECT count(*)::int AS n FROM birthday_changes WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(1);
    await notifier.announceDue({ today: '2027-09-09', hour: 9 });
    expect((await birthdays.mine('ann'))?.month).toBe(9);
    // A change row the erasure must reach (the tick above purged the one older than its day).
    await q(`INSERT INTO birthday_changes ("userId") VALUES ('ann') ON CONFLICT DO NOTHING`);
    expect((await birthdays.mine('ann'))?.month).toBe(9);
    for (const statement of ERASURE_STATEMENTS) {
      if (
        ['profile_birthdays', 'birthday_changes', 'post_notifications'].includes(statement.label)
      ) {
        await q(statement.sql, ['ann']);
      }
    }
    expect(await birthdays.mine('ann')).toBeNull();
    expect(
      (await q(`SELECT count(*)::int AS n FROM birthday_changes WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(0);
    expect(await birthdayRows()).toEqual([]);
  });

  it('celebrates a date set or moved today from its next occurrence, never today', async () => {
    await q(`DELETE FROM post_notifications`);
    const { m, d, today } = await parisToday();
    await setFree('ann', { month: m, day: d, visibility: 'school' });
    // Set today: no ring for anybody, the member included, and no notice, all day.
    expect((await birthdays.ofUser('oth', 'ann')).today).toBe(false);
    expect((await birthdays.ofUser('ann', 'ann')).today).toBe(false);
    expect((await birthdays.today('oth')).userIds).toEqual([]);
    expect((await notifier.announceDue({ today, hour: 9 })).claimed).toBe(0);
    expect(await birthdayRows()).toEqual([]);
    // Once in effect, a visibility edit is not a new date: it never delays the day.
    await setYesterday();
    await birthdays.setMine('ann', { month: m, day: d, visibility: 'followers' });
    expect((await birthdays.ofUser('oth', 'ann')).today).toBe(true);
    expect((await notifier.announceDue({ today, hour: 9 })).claimed).toBe(1);
  });

  it('announces a member at most once in 300 days, wherever the date is moved', async () => {
    await q(`DELETE FROM post_notifications`);
    await setFree('ann', { month: 6, day: 10, visibility: 'followers' });
    expect((await notifier.announceDue({ today: '2027-06-10', hour: 9 })).claimed).toBe(1);
    // Moved to tomorrow after today's notice: tomorrow tells nobody...
    await setFree('ann', { month: 6, day: 11 });
    expect((await notifier.announceDue({ today: '2027-06-11', hour: 9 })).claimed).toBe(0);
    // ...nor the 299th day after...
    await setFree('ann', { month: 4, day: 4 });
    expect((await notifier.announceDue({ today: '2028-04-04', hour: 9 })).claimed).toBe(0);
    // ...and the 300th may be told again.
    await setFree('ann', { month: 4, day: 5 });
    expect((await notifier.announceDue({ today: '2028-04-05', hour: 9 })).claimed).toBe(1);
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann', 'fol<ann']);
    // A clear takes the day it was announced with it: nothing about the date is left.
    await birthdays.clearMine('ann');
    expect(
      (await q(`SELECT count(*)::int AS n FROM profile_birthdays WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(0);
  });

  it('refuses a new date within 30 days of the last, a clear then a set included, never a visibility edit', async () => {
    const { today } = await parisToday();
    expect((await birthdays.setMine('ann', { month: 5, day: 5 })).birthday).toEqual({
      month: 5,
      day: 5,
      visibility: 'followers',
    });
    // The next Paris day: the window runs from yesterday's set.
    await q(`UPDATE birthday_changes SET "changedAt" = now() - interval '1 day'`);
    const opensOn = (await birthdays.state('ann')).changeOpensOn;
    expect((await q(`SELECT to_char($1::date + 29, 'YYYY-MM-DD') AS d`, [today])).rows[0].d).toBe(
      opensOn
    );

    expect(await refusalOf(birthdays.setMine('ann', { month: 5, day: 6 }))).toBe(
      BIRTHDAY_CHANGE_TOO_SOON
    );
    // The same date, or another visibility, is no change.
    expect(
      (await birthdays.setMine('ann', { month: 5, day: 5, visibility: 'school' })).birthday
    ).toEqual({ month: 5, day: 5, visibility: 'school' });
    // A clear is always accepted, and a set after it is a change.
    expect(await birthdays.clearMine('ann')).toEqual({ birthday: null, changeOpensOn: opensOn });
    expect(await refusalOf(birthdays.setMine('ann', { month: 5, day: 5 }))).toBe(
      BIRTHDAY_CHANGE_TOO_SOON
    );
    expect(await birthdays.mine('ann')).toBeNull();

    // 30 Paris days later the window is open, and the hourly job has deleted the row.
    await q(`UPDATE birthday_changes SET "changedAt" = now() - interval '31 days'`);
    await q(
      `INSERT INTO birthday_changes ("userId", "changedAt") VALUES ('oth', now() - interval '29 days')`
    );
    expect((await notifier.announceDue({ today, hour: 3 })).purged).toBe(1);
    expect(
      (await q(`SELECT "userId" FROM birthday_changes ORDER BY 1`)).rows.map((r) => r.userId)
    ).toEqual(['oth']);
    expect((await birthdays.setMine('ann', { month: 5, day: 6 })).birthday?.day).toBe(6);
  });

  it('accepts corrections the same Paris day without restarting the window, and refuses the next day', async () => {
    const { today } = await parisToday();
    await birthdays.setMine('ann', { month: 5, day: 5 });
    const firstSet = (await q(`SELECT "changedAt" FROM birthday_changes WHERE "userId" = 'ann'`))
      .rows[0].changedAt as Date;
    // A typo fixed twice, then a clear and a set: all the same day, all accepted.
    expect((await birthdays.setMine('ann', { month: 5, day: 6 })).birthday?.day).toBe(6);
    expect((await birthdays.setMine('ann', { month: 5, day: 7 })).birthday?.day).toBe(7);
    await birthdays.clearMine('ann');
    const again = await birthdays.setMine('ann', { month: 5, day: 8 });
    expect(again).toEqual({
      birthday: { month: 5, day: 8, visibility: 'followers' },
      changeOpensOn: null,
    });
    // The window still runs from the day's FIRST set.
    expect(
      (await q(`SELECT "changedAt" FROM birthday_changes WHERE "userId" = 'ann'`)).rows[0].changedAt
    ).toEqual(firstSet);
    // The next day: refused, until the 30th day after that first set.
    await q(`UPDATE birthday_changes SET "changedAt" = "changedAt" - interval '1 day'`);
    expect(await refusalOf(birthdays.setMine('ann', { month: 5, day: 9 }))).toBe(
      BIRTHDAY_CHANGE_TOO_SOON
    );
    expect((await birthdays.state('ann')).changeOpensOn).toBe(
      (await q(`SELECT to_char($1::date + 29, 'YYYY-MM-DD') AS d`, [today])).rows[0].d
    );
  });

  it('after an announcement, a clear then a set announces and rings nothing before day 300', async () => {
    await q(`DELETE FROM post_notifications`);
    await setFree('ann', { month: 6, day: 10, visibility: 'followers' });
    expect((await notifier.announceDue({ today: '2027-06-10', hour: 9 })).claimed).toBe(1);
    // "Retirer": the date goes, and only the day a notice opens again stays - no date of birth.
    await birthdays.clearMine('ann');
    const kept = (
      await q(
        `SELECT to_char("noticeOpensOn", 'YYYY-MM-DD') AS opens FROM birthday_changes
          WHERE "userId" = 'ann'`
      )
    ).rows;
    expect(kept).toEqual([{ opens: '2028-04-05' }]);
    expect(
      (await q(`SELECT count(*)::int AS n FROM profile_birthdays WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(0);

    // 30 days on, a new date is accepted - and announced on none of its days before day 300.
    const openWindow = () => q(`UPDATE birthday_changes SET "changedAt" = NULL`);
    await openWindow();
    await birthdays.setMine('ann', { month: 7, day: 11 });
    expect((await notifier.announceDue({ today: '2027-07-11', hour: 9 })).claimed).toBe(0);
    await openWindow();
    await birthdays.setMine('ann', { month: 4, day: 4 });
    expect((await notifier.announceDue({ today: '2028-04-04', hour: 9 })).claimed).toBe(0);
    await openWindow();
    await birthdays.setMine('ann', { month: 4, day: 5 });
    expect((await notifier.announceDue({ today: '2028-04-05', hour: 9 })).claimed).toBe(1);
    // The day it passes, the hourly job empties it and the row goes.
    expect(
      (await q(`SELECT count(*)::int AS n FROM birthday_changes WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(0);
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann', 'fol<ann']);
  });

  it('rings only on a day whose notice was sent or may be: a monthly move moves no ring', async () => {
    const { m, d, today } = await parisToday();
    await setFree('ann', { month: m, day: d, visibility: 'school' });
    await setYesterday();
    const ringed = async () => (await birthdays.ofUser('oth', 'ann')).today;
    const listed = async () => (await birthdays.today('oth')).userIds;
    // Announced a month ago, the date moved onto today: no ring, for the member neither.
    await q(`UPDATE profile_birthdays SET "lastAnnouncedOn" = $1::date - 30`, [today]);
    expect(await ringed()).toBe(false);
    expect((await birthdays.ofUser('ann', 'ann')).today).toBe(false);
    expect(await listed()).toEqual([]);
    // Announced today, or 300 days ago or more: the ring.
    await q(`UPDATE profile_birthdays SET "lastAnnouncedOn" = $1::date`, [today]);
    expect(await ringed()).toBe(true);
    await q(`UPDATE profile_birthdays SET "lastAnnouncedOn" = $1::date - 300`, [today]);
    expect(await ringed()).toBe(true);
    expect(await listed()).toEqual(['ann']);
    // A gate a clear kept holds the ring until its day.
    await q(`UPDATE birthday_changes SET "noticeOpensOn" = $1::date + 5 WHERE "userId" = 'ann'`, [
      today,
    ]);
    expect(await ringed()).toBe(false);
    await q(`UPDATE birthday_changes SET "noticeOpensOn" = $1::date`, [today]);
    expect(await ringed()).toBe(true);
  });
});
