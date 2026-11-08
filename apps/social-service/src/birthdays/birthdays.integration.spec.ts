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
import { BIRTHDAY_BODY_INVALID, BirthdaysService } from './birthdays.service';
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

  beforeEach(() => {
    pushed.length = 0;
  });

  it('starts empty: no account has a birthday, so nobody has a ring or a notice', async () => {
    expect((await q(`SELECT count(*)::int AS n FROM profile_birthdays`)).rows[0].n).toBe(0);
    expect(await birthdays.mine('ann')).toBeNull();
    expect(await birthdays.ofUser('fol', 'ann')).toEqual({ birthday: null, today: false });
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
    expect(await birthdays.setMine('ann', { month: 3, day: 14 })).toEqual({
      month: 3,
      day: 14,
      visibility: 'followers',
    });
    await birthdays.setMine('ann', { month: 3, day: 14, visibility: 'school' });
    expect(await birthdays.setMine('ann', { month: 3, day: 15 })).toEqual({
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
    expect(columns).toEqual(['day', 'month', 'updatedAt', 'userId', 'visibility']);
  });

  it('shows the date to exactly the viewers its visibility names', async () => {
    const date = { month: 3, day: 15 };
    await birthdays.setMine('ann', { ...date, visibility: 'school' });
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
    const [{ m, d }] = (
      await q(
        `SELECT EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Paris')::date)::int AS m,
                EXTRACT(DAY FROM (now() AT TIME ZONE 'Europe/Paris')::date)::int AS d`
      )
    ).rows as Array<{ m: number; d: number }>;
    await birthdays.setMine('ann', { month: m, day: d, visibility: 'nobody' });
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
    await birthdays.setMine('ann', { month: m, day: d === 1 ? 2 : 1 });
    expect((await birthdays.ofUser('oth', 'ann')).today).toBe(false);
    expect((await birthdays.today('oth')).userIds).toEqual([]);
  });

  it('celebrates a 29 February on the 28th of a common year, and on the 29th of a leap year', async () => {
    await q(`DELETE FROM profile_birthdays`);
    await q(`DELETE FROM birthday_notices`);
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
          `SELECT to_char("celebratedOn", 'YYYY-MM-DD') AS d FROM birthday_notices ORDER BY 1`
        )
      ).rows.map((r) => r.d)
    ).toEqual(['2027-02-28', '2028-02-29', '2100-02-28']);
  });

  it('tells, from the morning, the accepted followers who may read the date - once per day', async () => {
    await q(`DELETE FROM profile_birthdays`);
    await q(`DELETE FROM birthday_notices`);
    await q(`DELETE FROM post_notifications`);
    await birthdays.setMine('ann', { month: 6, day: 21, visibility: 'school' });

    // Before 8 in Paris: nothing, and nothing claimed.
    expect(await notifier.announceDue({ today: '2027-06-21', hour: 7 })).toMatchObject({
      due: 0,
      claimed: 0,
    });
    expect((await q(`SELECT count(*)::int AS n FROM birthday_notices`)).rows[0].n).toBe(0);

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

    // Two racing ticks on a NEW day: one claim, one row, one push.
    await birthdays.setMine('ann', { month: 6, day: 22 });
    const race = await Promise.all([
      notifier.announceDue({ today: '2027-06-22', hour: 10 }),
      notifier.announceDue({ today: '2027-06-22', hour: 10 }),
    ]);
    expect(race[0].claimed + race[1].claimed).toBe(1);
    await flush();
    expect(await birthdayRows()).toEqual(['fol<ann', 'fol<ann']);
    expect(pushed).toEqual(['fol:social_birthday:ANN']);
  });

  it('tells nobody when the date is hidden, and the bell is withheld by a bell on the person', async () => {
    await q(`DELETE FROM birthday_notices`);
    await q(`DELETE FROM post_notifications`);
    await birthdays.setMine('ann', { month: 7, day: 1, visibility: 'nobody' });
    expect(await notifier.announceDue({ today: '2027-07-01', hour: 9 })).toMatchObject({
      claimed: 1,
      told: 0,
    });
    expect(await birthdayRows()).toEqual([]);

    // A follower who set ann's bell to "Rien": the row is written, the push is not.
    await birthdays.setMine('ann', { month: 7, day: 2, visibility: 'followers' });
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
    await q(`DELETE FROM birthday_notices`);
    await q(`DELETE FROM post_notifications`);
    await birthdays.setMine('ann', { month: 8, day: 1, visibility: 'followers' });
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
    await birthdays.setMine('ann', { month: 9, day: 9 });
    await notifier.announceDue({ today: '2027-09-09', hour: 9 });
    expect((await birthdays.mine('ann'))?.month).toBe(9);
    for (const statement of ERASURE_STATEMENTS) {
      if (
        ['profile_birthdays', 'birthday_notices', 'post_notifications'].includes(statement.label)
      ) {
        await q(statement.sql, ['ann']);
      }
    }
    expect(await birthdays.mine('ann')).toBeNull();
    expect(
      (await q(`SELECT count(*)::int AS n FROM birthday_notices WHERE "userId" = 'ann'`)).rows[0].n
    ).toBe(0);
    expect(await birthdayRows()).toEqual([]);
  });
});
