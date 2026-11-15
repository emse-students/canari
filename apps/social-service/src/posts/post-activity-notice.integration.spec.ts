/**
 * ONE LIVE NOTIFICATION PER POST for comments and reactions on the reader's own post (owner,
 * 2026-11-14; docs/wiki/engagement.md, "The owner's decision of 2026-11-14") against a REAL
 * PostgreSQL: the bell rows' read state decides alert or quiet, in one transaction under the
 * reader's lock, and the push carries the per-post identity and the quiet flag.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- post-activity-notice.integration
 */
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import {
  ANONYMOUS_NOTIFICATION_ACTOR_ID,
  PostNotificationsService,
} from './post-notifications.service';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import {
  MIN_APP_VERSION_DATA_KEY,
  POST_ACTIVITY_QUIET_MIN_CLIENT_VERSION,
} from '../push/notification-client-floor';
import { postActivityCollapseId } from './post-activity-notice';
import { commentContent, reactionContent, type PushContent } from '../push/push-content';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
/** The reader's two posts: ids the bell's check can cast to a uuid. */
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const maybe = URL ? describe : describe.skip;

maybe('one live notification per post (owner, 2026-11-14) against PostgreSQL', () => {
  const schema = `activity_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let pool: Pool;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  /** What TypeORM's manager answers, with a transaction on ONE pooled connection. */
  const manager = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params).then((r) => r.rows),
    transaction: async <T>(
      work: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<T>
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await work({
          query: (sql, params) => client.query(sql, params).then((r) => r.rows),
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
  const pushed: { userId: string; content: PushContent; data: Record<string, string> }[] = [];

  function service(): PostNotificationsService {
    const push = {
      notifyContent: (userId: string, content: PushContent, data: Record<string, string>) => {
        pushed.push({ userId, content, data });
        return Promise.resolve();
      },
    };
    return new PostNotificationsService(
      { manager } as never,
      { manager } as never,
      push as never,
      { withheldAmong: () => Promise.resolve(new Set<string>()) } as never
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    // The tables the bell's own visibility check (`bellRowShownSql`) reads, as bell-page's spec builds them.
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
    await createPostNotificationsTable((sql) => q(sql));
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      // `commentId`, which alters `read_grant_journal` and so follows 078.
      '132_read_grant_readers.sql',
      '121_member_reposts.sql',
      '148_profile_birthdays.sql',
    ]) {
      await q(readFileSync(join(__dirname, '..', 'migrations', file), 'utf8'));
    }
    pool = new Pool({ connectionString: URL, max: 16, options: `-c search_path=${schema},public` });
  });

  afterAll(async () => {
    await pool?.end();
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await q(`TRUNCATE post_notifications`);
    await q(`DELETE FROM posts`);
    await q(`DELETE FROM users`);
    await q(`INSERT INTO users (id, campus) VALUES ('author', 'saint-etienne')`);
    await q(`INSERT INTO posts (id, "authorId") VALUES ($1, 'author'), ($2, 'author')`, [P1, P2]);
    pushed.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const comment = (svc: PostNotificationsService, actor: string, post = P1, to = 'author') =>
    svc.notifyPostActivity({
      recipientId: to,
      type: 'comment',
      postId: post,
      actorId: actor,
      actorName: actor.toUpperCase(),
      text: `hello from ${actor}`,
      commentId: `c-${actor}`,
      content: (others) =>
        commentContent(actor.toUpperCase(), `hello from ${actor}`, undefined, others),
      pushData: { commentId: `c-${actor}` },
    });
  const reaction = (svc: PostNotificationsService, actor: string, post = P1) =>
    svc.notifyPostActivity({
      recipientId: 'author',
      type: 'reaction',
      postId: post,
      actorId: actor,
      actorName: actor.toUpperCase(),
      text: "J'aime",
      content: (others) => reactionContent(actor.toUpperCase(), '❤️', undefined, others),
    });

  it('the first comment ALERTS, the next ones update the same notification QUIETLY, naming the others', async () => {
    const svc = service();
    expect(await comment(svc, 'alice')).toEqual({ alert: true, others: 0 });
    expect(await comment(svc, 'bob')).toEqual({ alert: false, others: 1 });
    expect(await comment(svc, 'carol')).toEqual({ alert: false, others: 2 });
    // Alice again: the others are Bob and Carol, never herself.
    expect(await comment(svc, 'alice')).toEqual({ alert: false, others: 2 });

    const collapseId = postActivityCollapseId(P1);
    // A quiet update carries the floor of the builds that honour `quiet`: an older one would ring it.
    const quiet = {
      quiet: 'true',
      [MIN_APP_VERSION_DATA_KEY]: POST_ACTIVITY_QUIET_MIN_CLIENT_VERSION,
    };
    expect(pushed.map((p) => p.data)).toEqual([
      { type: 'social', postId: P1, commentId: 'c-alice', collapseId },
      { type: 'social', postId: P1, commentId: 'c-bob', collapseId, ...quiet },
      { type: 'social', postId: P1, commentId: 'c-carol', collapseId, ...quiet },
      { type: 'social', postId: P1, commentId: 'c-alice', collapseId, ...quiet },
    ]);
    expect(pushed.map((p) => p.content.count)).toEqual([0, 1, 2, 2]);
    expect(collapseId).toBe(`post_activity_${P1}`);
    // Every comment is in the bell: nothing is dropped.
    const rows = await q(`SELECT count(*)::int AS n FROM post_notifications WHERE NOT read`);
    expect(rows.rows[0].n).toBe(4);
  });

  it('a read makes the next one ALERT again - of the post, or of the whole bell', async () => {
    const svc = service();
    await comment(svc, 'alice');
    await comment(svc, 'bob');
    await svc.markPostRead('author', P1);
    expect(await comment(svc, 'carol')).toEqual({ alert: true, others: 0 });
    await svc.markAllRead('author');
    expect(await reaction(svc, 'dan')).toEqual({ alert: true, others: 0 });
  });

  it('comments and reactions share ONE state per post, each counting its own kind', async () => {
    const svc = service();
    await comment(svc, 'alice');
    expect(await reaction(svc, 'bob')).toEqual({ alert: false, others: 0 });
    expect(await reaction(svc, 'carol')).toEqual({ alert: false, others: 1 });
    expect(pushed.map((p) => p.content.key)).toEqual([
      'social_comment',
      'social_reaction',
      'social_reaction',
    ]);
    // Another post of the same reader is its own notification.
    expect(await comment(svc, 'alice', P2)).toEqual({ alert: true, others: 0 });
    expect(pushed[3].data.collapseId).toBe(`post_activity_${P2}`);
  });

  it('an unread row of ANOTHER kind (a reply on the same post) does not make a comment quiet', async () => {
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
       VALUES ('author', 'reply', $1, 'x', 'r')`,
      [P1]
    );
    expect(await comment(service(), 'alice')).toEqual({ alert: true, others: 0 });
  });

  it('a row whose push the reader switched off never silences the kind still on (review of #3579)', async () => {
    // "Commentaires" off: the comments are written, never pushed - a reaction must still ring.
    await q(
      `INSERT INTO notification_preference ("userId", "disabledCategories") VALUES ('author', '["comments"]')`
    );
    const svc = service();
    await comment(svc, 'alice');
    await comment(svc, 'bob');
    expect(await reaction(svc, 'carol')).toEqual({ alert: true, others: 0 });
    expect(await reaction(svc, 'dan')).toEqual({ alert: false, others: 1 });
    await q(`DELETE FROM notification_preference`);
  });

  it('a row the BELL hides never counts as an unread notification (review of #3579)', async () => {
    // A comment the bell does not show - its post hidden by moderation - is not unread for the
    // reader, so the next comment must RING; and once the post is shown again, the row counts.
    const svc = service();
    expect(await comment(svc, 'alice')).toEqual({ alert: true, others: 0 });
    await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [P1]);
    expect(await comment(svc, 'bob')).toEqual({ alert: true, others: 0 });
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P1]);
    expect(await comment(svc, 'carol')).toEqual({ alert: false, others: 2 });
  });

  it('a dozen comments arriving TOGETHER write a dozen rows and exactly ONE alert', async () => {
    const svc = service();
    const actors = Array.from({ length: 12 }, (_, i) => `actor${i}`);
    const verdicts = await Promise.all(actors.map((a) => comment(svc, a)));
    expect(verdicts.filter((v) => v?.alert)).toHaveLength(1);
    // The quiet ones count the others written before them: 1..11, each once.
    expect(
      verdicts
        .filter((v) => !v?.alert)
        .map((v) => v!.others)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    const rows = await q(`SELECT count(*)::int AS n FROM post_notifications`);
    expect(rows.rows[0].n).toBe(12);
  });

  it('a comment and a read racing never leave a silent row behind a cleared bell', async () => {
    const svc = service();
    await comment(svc, 'alice');
    // Whichever takes the reader's lock first, the outcome is one of the two exact ones: the read
    // first (the comment alerts), or the comment first (quiet, and the read then covers it).
    const [verdict] = await Promise.all([comment(svc, 'bob'), svc.markAllRead('author')]);
    const unread = await q(`SELECT count(*)::int AS n FROM post_notifications WHERE NOT read`);
    expect(unread.rows[0].n).toBe(verdict!.alert ? 1 : 0);
  });

  it('an anonymous or association comment counts once per comment: its actor id names nobody', async () => {
    const svc = service();
    const masked = (n: number) =>
      svc.notifyPostActivity({
        recipientId: 'author',
        type: 'comment',
        postId: P1,
        actorId: ANONYMOUS_NOTIFICATION_ACTOR_ID,
        actorName: 'Anonyme',
        text: `masked ${n}`,
        content: (others) => commentContent('Anonyme', `masked ${n}`, undefined, others),
      });
    expect(await masked(1)).toEqual({ alert: true, others: 0 });
    expect(await masked(2)).toEqual({ alert: false, others: 1 });
    expect(await masked(3)).toEqual({ alert: false, others: 2 });
  });

  it("the actor's own act on their own post writes nothing and pushes nothing", async () => {
    expect(await comment(service(), 'author')).toBeNull();
    expect(pushed).toEqual([]);
    const rows = await q(`SELECT count(*)::int AS n FROM post_notifications`);
    expect(rows.rows[0].n).toBe(0);
  });
});
