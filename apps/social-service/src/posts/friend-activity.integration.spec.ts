/**
 * FRIENDS' ACTIVITY (engagement WP-9) against a REAL PostgreSQL: migration 158 as it ships, one case
 * per rule of the disclosure list (docs/wiki/engagement.md, "(b) friends' activity - the disclosure
 * rule"), rule 0 included and rule 8 once for each of its three comment shapes, the told-once ledger,
 * and the in-app row and push the told readers get through `createNotifications` (the bell and the
 * WP-8 cap on the way).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- friend-activity.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { announceFriendActivity, type FriendAct } from './friend-activity';
import { PostNotificationsService } from './post-notifications.service';
import type { StoredComment } from './comment-identity';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import { ActivitySettingsService } from './activity-settings.controller';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import { REVIEW_COHORT_ENV } from '../review-cohort';
import type { PushContent } from '../push/push-content';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const ICM = JSON.stringify([{ formation: 'ICM', promo: 2025 }]);
const ISMIN = JSON.stringify([{ formation: 'ISMIN', promo: 2025 }]);

/** Gardanne's association: a Saint-Etienne reader sees its posts only through a read grant. */
const EG = '5e000000-0000-4000-8000-0000000000e9';

/** A post id per case, readable in a failure. */
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

maybe("friends' activity against PostgreSQL (engagement WP-9)", () => {
  const schema = `friend_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  const pushes: { to: string; content: PushContent }[] = [];
  const previousCohort = process.env[REVIEW_COHORT_ENV];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const manager = { query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows };

  const notifications = new PostNotificationsService(
    {
      manager,
      create: (row: Record<string, unknown>) => row,
      save: async (rows: Record<string, unknown>[]) => {
        for (const r of rows) {
          await q(
            `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName", text)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [r.recipientId, r.type, r.postId, r.actorId, r.actorName, r.text]
          );
        }
        return rows;
      },
    } as never,
    { manager } as never,
    {
      notifyContent: (to: string, content: PushContent) => {
        pushes.push({ to, content });
        return Promise.resolve();
      },
    } as never,
    { withheldAmong: () => Promise.resolve(new Set<string>()) } as never
  );

  const post = (
    id: string,
    author: string,
    opts: { association?: string; anonymous?: boolean; hidden?: boolean; markdown?: string } = {}
  ) =>
    q(
      `INSERT INTO posts (id, "authorId", "associationId", anonymous, "hiddenByModeration", markdown)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        author,
        opts.association ?? null,
        opts.anonymous ?? false,
        opts.hidden ?? false,
        opts.markdown ?? 'Bonjour',
      ]
    );
  const follow = (a: string, b: string, status = 'accepted') =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), $1, $2, $3::varchar, CASE WHEN $3::varchar = 'accepted' THEN now() END)`,
      [a, b, status]
    );
  const user = (id: string, campus = SE, cursus = ICM) =>
    q(`INSERT INTO users (id, campus, cursus, "displayName") VALUES ($1, $2, $3, $1)`, [
      id,
      campus,
      cursus,
    ]);
  const tell = (postId: string, actorId: string, act: FriendAct, comment?: StoredComment) =>
    announceFriendActivity(
      { manager, notifications },
      { post: { id: postId, markdown: 'Bonjour' }, actorId, act, comment }
    );
  const told = async (postId: string): Promise<string[]> =>
    (
      await q(`SELECT "recipientId" FROM post_engagement_notices WHERE "postId" = $1 ORDER BY 1`, [
        postId,
      ])
    ).rows.map((r) => r.recipientId);
  const plain = (userId: string): StoredComment =>
    ({ id: 'c', userId, text: 'hi' }) as StoredComment;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false,
        anonymous boolean NOT NULL DEFAULT false, "hiddenByModeration" boolean NOT NULL DEFAULT false,
        "scheduledAt" timestamptz, kind varchar NOT NULL DEFAULT 'post', markdown text,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
    `);
    await q(migration('114_user_follow_status.sql'));
    await createPostNotificationsTable((sql) => q(sql));
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('132_read_grant_readers.sql'));
    await q(migration('121_member_reposts.sql'));
    await q(migration('157_engagement_push_days.sql'));
    await q(migration('158_friend_activity.sql'));
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('158_friend_activity.sql'));
    await q(
      readFileSync(
        join(
          __dirname,
          '../../../chat-delivery-service/src/migrations/028_notification_preferences.sql'
        ),
        'utf8'
      )
    );
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'EG', 'eg')`, [EG]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
      [EG, GA]
    );

    // x acts; a writes the posts. Every other one follows x, accepted, unless named otherwise.
    for (const id of ['x', 'a', 'r1', 'r2', 'pend', 'nof', 'blk1', 'blk2', 'blk3', 'grant', 'told'])
      await user(id);
    await user('g', GA, ISMIN);
    for (const id of ['r1', 'r2', 'g', 'blk1', 'blk2', 'blk3', 'grant', 'told', 'a'])
      await follow(id, 'x');
    await follow('pend', 'x', 'pending');
    await q(`INSERT INTO user_blocks VALUES ('blk1', 'x'), ('x', 'blk2'), ('a', 'blk3')`);
    // `grant` is a Saint-Etienne reader holding a read grant on Gardanne: EG's posts in their feed.
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('grant', $1, NULL, 'admin')`,
      [GA]
    );
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    pushes.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await q(`DELETE FROM user_activity_settings`);
  });

  /** Who shares a's space and follows x, accepted, with no block: the readers a post of a reaches. */
  const REACHED = ['grant', 'r1', 'r2', 'told'];

  it('tells the accepted followers of X who see the post, and pushes them - rules 1, 2, 4, 6', async () => {
    await post(P(1), 'a');
    expect(await tell(P(1), 'x', 'reaction')).toBe(4);
    // Not g (Gardanne: does not see the post, rule 2), not pend (a request, rule 1), not nof (no
    // follow), not blk1 / blk2 (a block with X) nor blk3 (a block with the author, rule 4), not a
    // (the author, rule 6).
    expect(await told(P(1))).toEqual(REACHED);
    const rows = await q(
      `SELECT "recipientId", type, "actorId", text FROM post_notifications WHERE "postId" = $1 ORDER BY 1`,
      [P(1)]
    );
    expect(rows.rows).toEqual(
      REACHED.map((r) => ({
        recipientId: r,
        type: 'friend_reaction',
        actorId: 'x',
        text: 'Bonjour',
      }))
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(pushes.map((p) => p.to).sort()).toEqual(REACHED);
    expect(pushes[0].content.key).toBe('social_friend_reaction');
    expect(pushes[0].content.actorName).toBe('x');
  });

  it('rule 0: X turned "share my activity" off - nobody is told; on again, they are', async () => {
    await post(P(2), 'a');
    const settings = new ActivitySettingsService({ query: manager.query } as never);
    expect(await settings.read('x')).toEqual({ shareActivity: true });
    expect(await settings.write('x', false)).toEqual({ shareActivity: false });
    expect(await tell(P(2), 'x', 'reaction')).toBe(0);
    expect(await settings.write('x', true)).toEqual({ shareActivity: true });
    expect(await tell(P(2), 'x', 'comment', plain('x'))).toBe(4);
  });

  it('rule 2: a hidden post tells nobody', async () => {
    await post(P(3), 'a', { hidden: true });
    expect(await tell(P(3), 'x', 'reaction')).toBe(0);
  });

  it('rules 2 and 3: a reader who sees the post only through a read grant is not told', async () => {
    await post(P(4), 'm', { association: EG });
    expect(await tell(P(4), 'x', 'reaction')).toBe(1);
    // g sees EG's post natively (Gardanne); grant reads it only through the grant.
    expect(await told(P(4))).toEqual(['g']);
  });

  it('rule 5: a comment on an anonymous post tells nobody; a reaction on it may be told', async () => {
    await post(P(5), 'a', { anonymous: true });
    expect(await tell(P(5), 'x', 'comment', plain('x'))).toBe(0);
    expect(await tell(P(5), 'x', 'reaction')).toBe(4);
  });

  it('rule 6: X acting on their own post tells nobody', async () => {
    await post(P(6), 'x');
    expect(await tell(P(6), 'x', 'reaction')).toBe(0);
  });

  it('rule 7: told once - a reader with a row for the post, or told before, is not told again', async () => {
    await post(P(7), 'a');
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
       VALUES ('told', 'followed_post', $1, 'a', 'Bonjour')`,
      [P(7)]
    );
    expect(await tell(P(7), 'x', 'reaction')).toBe(3);
    expect(await told(P(7))).toEqual(['grant', 'r1', 'r2']);
    // X comments after reacting: the readers told of the reaction are not told of the comment.
    expect(await tell(P(7), 'x', 'comment', plain('x'))).toBe(0);
  });

  it('rule 8: an anonymous comment, one written as an association, a removed one - never told', async () => {
    await post(P(8), 'a');
    const query = jest.spyOn(manager, 'query');
    for (const comment of [
      { ...plain('x'), anonymous: true },
      { ...plain('x'), associationId: EG },
      { ...plain('x'), removedByModeration: true },
    ] as StoredComment[]) {
      expect(await tell(P(8), 'x', 'comment', comment)).toBe(0);
    }
    expect(query).not.toHaveBeenCalled();
    expect(await told(P(8))).toEqual([]);
  });

  it('never across the review cohort', async () => {
    await post(P(11), 'a');
    process.env[REVIEW_COHORT_ENV] = 'r1';
    try {
      expect(await tell(P(11), 'x', 'reaction')).toBe(3);
    } finally {
      if (previousCohort === undefined) delete process.env[REVIEW_COHORT_ENV];
      else process.env[REVIEW_COHORT_ENV] = previousCohort;
    }
    expect(await told(P(11))).toEqual(['grant', 'r2', 'told']);
  });

  it('the erasure takes the setting and the ledger', async () => {
    await post(P(9), 'a');
    await tell(P(9), 'x', 'reaction');
    await q(`INSERT INTO user_activity_settings ("userId", "shareActivity") VALUES ('r1', false)`);
    for (const label of ['user_activity_settings', 'post_engagement_notices']) {
      await q(ERASURE_STATEMENTS.find((s) => s.label === label)!.sql, ['r1']);
    }
    expect(await told(P(9))).toEqual(['grant', 'r2', 'told']);
    expect(
      (await q(`SELECT count(*)::int AS n FROM user_activity_settings WHERE "userId" = 'r1'`))
        .rows[0].n
    ).toBe(0);
  });

  it('the ledger goes with its post', async () => {
    await post(P(10), 'a');
    await tell(P(10), 'x', 'reaction');
    await q(`DELETE FROM posts WHERE id = $1`, [P(10)]);
    expect(await told(P(10))).toEqual([]);
  });
});
