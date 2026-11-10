/**
 * THE BELL'S PAGE STOPS WITH THE PAGE (review of #2965), against a REAL PostgreSQL - migrations
 * 071, 072, 073, 078, 121 and 126 applied.
 *
 * Since every post-bound row re-checks that its reader still sees the post (`bellRowShownSql`, a
 * correlated subquery), the cost of the bell is the number of rows that check runs on. This seeds a
 * reader with more history than production's heaviest recipient (149 rows over the 90-day
 * retention, measured 2026-11-03) among other readers' rows, and asserts on `EXPLAIN ANALYZE` of
 * the very statement `getNotifications` runs (`bellPageQuery`): migration 126's index walked in
 * order, no sort, and about one page of rows read - and that the page itself is right.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { PostNotificationsService } from './post-notifications.service';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import { PG_SESSION_OPTIONS } from '../common/pg-session-options';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const ASSO = '00000000-0000-4000-8000-0000000d0001';
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The reader's own rows, well above production's heaviest recipient. */
const MINE = 600;
/** Everyone else's: the reader's rows are a minority of the table, as in production. */
const OTHERS = 40;
const PER_OTHER = 150;
const PAGE = 30;

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};

/** Every node of a plan, depth first. */
function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

maybe('the bell page against PostgreSQL (migration 126)', () => {
  const schema = `bell_page_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let bell: PostNotificationsService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PostNotification],
      synchronize: false,
      // The service's own session settings (`PG_SESSION_OPTIONS`), as `AppModule` opens its pool.
      extra: { options: `${PG_SESSION_OPTIONS} -c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16), "reachSpaces" jsonb, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
    `);
    // The bell's table as the estates hold it - its columns' types from the migrations (#3019's 500).
    await createPostNotificationsTable(q);
    await q(
      `CREATE INDEX "IDX_post_notifications_recipient" ON post_notifications ("recipientId")`
    );
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'ASSO', 'asso')`, [ASSO]);
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '121_member_reposts.sql',
      // The bell re-reads a birthday notice against its date (`birthdayRowShownSql`).
      '148_profile_birthdays.sql',
      '126_post_notifications_recipient_created.sql',
    ]) {
      await q(migration(file));
    }
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('126_post_notifications_recipient_created.sql'));
    // ASSO reaches ICM x saint-etienne (071's default); 'me' is there, 'far' is not.
    await q(`INSERT INTO users (id, campus, cursus) VALUES
      ('me', 'saint-etienne', '[{"formation":"ICM","promo":2024}]'),
      ('far', 'gardanne', '[{"formation":"ISMIN","promo":2024}]'),
      ('officer', 'saint-etienne', '[{"formation":"ICM","promo":2024}]')`);
    // One association post per bell row of the reader, as production's association_post majority.
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", "publishedAt")
         SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'officer', $1,
                now() - make_interval(mins => g)
           FROM generate_series(1, $2::int) g`,
      [ASSO, MINE]
    );
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text, "createdAt")
         SELECT 'me', 'association_post', '00000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
                'officer', 'p', now() - make_interval(mins => g)
           FROM generate_series(1, $1::int) g`,
      [MINE]
    );
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text, "createdAt")
         SELECT 'other-' || (g % $1::int), 'association_post',
                '00000000-0000-4000-8000-' || lpad((1 + g % $3::int)::text, 12, '0'), 'officer', 'p',
                now() - make_interval(mins => g)
           FROM generate_series(1, $1::int * $2::int) g`,
      [OTHERS, PER_OTHER, MINE]
    );
    await q(`ANALYZE post_notifications; ANALYZE posts; ANALYZE users`);
    bell = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      {} as never,
      {} as never
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('serves the newest page, every row checked against the post', async () => {
    const page = await bell.getNotifications('me', PAGE);
    expect(page).toHaveLength(PAGE);
    expect(page.map((n) => n.postId)).toEqual(Array.from({ length: PAGE }, (_, i) => P(i + 1)));
    // The far reader does not see ASSO's posts: the same rows addressed to them are not shown.
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
         VALUES ('far', 'association_post', $1, 'officer', 'p')`,
      [P(1)]
    );
    expect(await bell.getNotifications('far', PAGE)).toEqual([]);
  });

  it("walks migration 126's index newest first and stops with the page: no sort, no full history", async () => {
    const [sql, params] = bell.bellPageQuery('me', PAGE).getQueryAndParameters();
    const rows: { 'QUERY PLAN': { Plan: PlanNode }[] }[] = await q(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      params
    );
    const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan);
    expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');
    const scan = nodes.find((n) => n['Index Name'] === 'IDX_post_notifications_recipient_created');
    expect(scan).toBeDefined();
    // The visibility check ran on the page, not on the reader's MINE rows.
    expect(
      (scan!['Actual Rows'] ?? 0) + (scan!['Rows Removed by Filter'] ?? 0)
    ).toBeLessThanOrEqual(PAGE);
  });

  it('never JIT-compiles the page, however high its estimated cost (2026-11-09: 1-13 s of compilation)', async () => {
    // One connection for every statement, so the SETs below hold for the EXPLAINs that follow.
    const runner = ds.createQueryRunner();
    try {
      expect(await runner.query('SHOW jit')).toEqual([{ jit: 'off' }]);
      const [sql, params] = bell.bellPageQuery('me', PAGE).getQueryAndParameters();
      const planOf = async () => {
        const rows: { 'QUERY PLAN': Record<string, unknown>[] }[] = await runner.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
          params
        );
        return rows[0]['QUERY PLAN'][0];
      };
      // Every plan past the threshold - production's heavy reader crossed it on cost alone.
      await runner.query('SET jit_above_cost = 0');
      expect(await planOf()).not.toHaveProperty('JIT');
      // The control: the same statement on a session WITH JIT is compiled, so the assertion above
      // can fail. The server must be built with JIT, as the estates' and CI's images are
      // (`pg_jit_available()` also reads the session's `jit`, hence after the SET).
      await runner.query('SET jit = on');
      expect(await runner.query('SELECT pg_jit_available() AS available')).toEqual([
        { available: true },
      ]);
      expect(await planOf()).toHaveProperty('JIT');
    } finally {
      await runner.release();
    }
  });

  /**
   * NEVER A TYPE THE READER'S BUILD CANNOT DRAW (owner, 2026-11-10): `1.6.8` drew 1.6.9's campus
   * trends as "a notification this version cannot show". The read serves the types whose floor the
   * build it names meets (`notification-client-floor.ts`); a headerless read is a build up to 1.6.9.
   */
  it("serves only the types the reader's build draws, from the build it names", async () => {
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text, "createdAt")
         VALUES ('me', 'campus_trend', $1, 'system', 'p', now() + interval '2 minutes'),
                ('me', 'friend_reaction', $1, 'officer', 'p', now() + interval '1 minute')`,
      [P(1)]
    );
    try {
      const typesFor = async (build?: string) =>
        (await bell.getNotifications('me', 3, build)).map((n) => n.type);
      // Up to 1.6.9 (no header): what it was served before the rule, never the trend it drew wrong.
      expect(await typesFor(undefined)).toEqual([
        'friend_reaction',
        'association_post',
        'association_post',
      ]);
      // A 1.6.8 build that names itself is not served 1.6.9's friend activity either.
      expect(await typesFor('1.6.8')).toEqual([
        'association_post',
        'association_post',
        'association_post',
      ]);
      // The first build that draws a trend as a suggestion, a pre-release of it included.
      expect(await typesFor('1.6.10-alpha.1')).toEqual([
        'campus_trend',
        'friend_reaction',
        'association_post',
      ]);
      // A build it cannot read is served only what every admitted build draws: fail closed.
      expect(await typesFor('latest')).toEqual([
        'association_post',
        'association_post',
        'association_post',
      ]);
    } finally {
      await q(`DELETE FROM post_notifications WHERE type IN ('campus_trend', 'friend_reaction')`);
    }
  });
});
