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
      extra: { options: `-c search_path=${schema},public` },
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
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
      CREATE TABLE post_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "recipientId" varchar NOT NULL, type varchar NOT NULL, "postId" varchar NOT NULL,
        "actorId" varchar NOT NULL, "actorName" varchar, "associationId" varchar,
        "associationLogoUrl" varchar, text varchar NOT NULL, meta jsonb,
        read boolean NOT NULL DEFAULT false, "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE INDEX "IDX_post_notifications_recipient" ON post_notifications ("recipientId");
    `);
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'ASSO', 'asso')`, [ASSO]);
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '121_member_reposts.sql',
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
});
