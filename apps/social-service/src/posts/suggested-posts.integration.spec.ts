/**
 * SUGGESTED POSTS (engagement WP-7, decision 8) against a REAL PostgreSQL: a suggested post is one
 * the viewer sees by the SPACE rule - never through a read grant or a follower door - never by an
 * author blocked either way, never anonymous, the viewer's own or from an account they follow, and
 * popular by `engagedAccountsSql` (docs/wiki/engagement.md, "Suggested posts").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- suggested-posts.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { EntityManager } from 'typeorm';
import { SUGGESTED_POST_MIN_ENGAGED, suggestedPostIds } from './suggested-posts';
import {
  createNotificationPreferenceTable,
  turnSuggestionsOn,
} from './post-notifications.it-schema';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const ICM = JSON.stringify([{ formation: 'ICM', promo: 2025 }]);
const ISMIN = JSON.stringify([{ formation: 'ISMIN', promo: 2025 }]);

const E1 = '5e000000-0000-4000-8000-0000000000e1'; // reaches (ICM, SE)
const E2 = '5e000000-0000-4000-8000-0000000000e2'; // reaches (ICM, SE), v follows it
const E3 = '5e000000-0000-4000-8000-0000000000e3'; // reaches (ICM, SE), v is a member
const EG = '5e000000-0000-4000-8000-0000000000e9'; // reaches Gardanne only; v holds a grant there

/** A post id per case, readable in a failure. */
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** `n` distinct reactors (never the author), as `posts.reactions`. */
const reactors = (n: number) =>
  JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, 'like'])));

maybe('suggested posts against PostgreSQL (engagement WP-7)', () => {
  const schema = `suggested_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let manager: EntityManager;

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const post = (
    id: string,
    author: string,
    opts: {
      association?: string;
      reactions?: string;
      comments?: unknown[];
      anonymous?: boolean;
      kind?: string;
      daysAgo?: number;
      hidden?: boolean;
      scheduledInDays?: number;
    } = {}
  ) =>
    q(
      `INSERT INTO posts (id, "authorId", "associationId", anonymous, kind, reactions, comments,
         "hiddenByModeration", "publishedAt", "scheduledAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9),
         CASE WHEN $10::int IS NULL THEN NULL ELSE now() + make_interval(days => $10::int) END)`,
      [
        id,
        author,
        opts.association ?? null,
        opts.anonymous ?? false,
        opts.kind ?? 'post',
        opts.reactions ?? reactors(3),
        JSON.stringify(opts.comments ?? []),
        opts.hidden ?? false,
        opts.daysAgo ?? 1,
        opts.scheduledInDays ?? null,
      ]
    );
  const follow = (a: string, b: string, status = 'accepted') =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), $1, $2, $3::varchar, CASE WHEN $3::varchar = 'accepted' THEN now() END)`,
      [a, b, status]
    );
  const suggested = async (viewer = 'v') =>
    (await suggestedPostIds(manager, viewer, false)).map((id) => Number(id.slice(-12)));

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "isBDE" boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid,
        anonymous boolean NOT NULL DEFAULT false, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16), "reachSpaces" jsonb,
        kind varchar NOT NULL DEFAULT 'post', reactions jsonb NOT NULL DEFAULT '{}',
        comments jsonb NOT NULL DEFAULT '[]', "hiddenByModeration" boolean NOT NULL DEFAULT false,
        "publishedAt" timestamptz NOT NULL DEFAULT now(), "scheduledAt" timestamptz);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE association_follows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "followerUserId" varchar(255) NOT NULL, "associationId" uuid NOT NULL);
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
    `);
    await q(migration('114_user_follow_status.sql'));
    for (const id of [E1, E2, E3])
      await q(`INSERT INTO associations (id, name) VALUES ($1, $2)`, [id, id]);
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(`INSERT INTO associations (id, name) VALUES ($1, 'EG')`, [EG]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
      [EG, GA]
    );
    // v: the viewer. a, fol, pend, b1, b2: share v's space. g: Gardanne.
    for (const id of ['v', 'a', 'fol', 'pend', 'b1', 'b2', 'm']) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [id, SE, ICM]);
    }
    await q(`INSERT INTO users (id, campus, cursus) VALUES ('g', $1, $2)`, [GA, ISMIN]);
    // "Suggestions" is off until turned on (owner, 2026-11-10): every reader here turned it on but m.
    await createNotificationPreferenceTable((sql) => q(sql));
    await turnSuggestionsOn(q, ['v', 'a', 'fol', 'pend', 'b1', 'b2', 'g']);
    await follow('v', 'fol');
    await follow('v', 'pend', 'pending');
    await follow('v', 'g');
    await q(`INSERT INTO user_blocks VALUES ('v', 'b1'), ('b2', 'v')`);
    await q(
      `INSERT INTO association_follows ("followerUserId", "associationId") VALUES ('v', $1)`,
      [E2]
    );
    await q(`INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'v')`, [E3]);
    // A read grant on Gardanne: v READS EG's posts in the feed, and is never suggested one.
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('v', $1, NULL, 'admin')`,
      [GA]
    );

    // Suggested: a stranger of v's space, and an entity v neither follows nor belongs to.
    await post(P(1), 'a');
    await post(P(2), 'm', { association: E1, reactions: reactors(5) });
    // The author's own reaction does not count: 2 others + one commenter twice + one more = 3.
    await post(P(3), 'a', {
      reactions: JSON.stringify({ a: 'like', r0: 'like', r1: 'like' }),
      comments: [{ userId: 'r1' }, { userId: 'c9' }, { userId: 'a' }],
    });
    // Not popular enough: 2 distinct others (a comment by a reactor counts once).
    await post(P(4), 'a', {
      reactions: JSON.stringify({ a: 'like', r0: 'like' }),
      comments: [{ userId: 'r0' }, { userId: 'r1' }, { userId: 'a' }],
    });
    // Each excluded by one rule.
    await post(P(10), 'a', { daysAgo: 8 }); // older than the window
    await post(P(11), 'a', { anonymous: true });
    await post(P(12), 'a', { hidden: true });
    await post(P(13), 'a', { kind: 'reel' });
    await post(P(14), 'a', { scheduledInDays: 1, daysAgo: 0 });
    await post(P(15), 'fol'); // followed
    await post(P(16), 'pend'); // asked
    await post(P(17), 'g'); // seen only through the follower door
    await post(P(18), 'b1'); // v blocked them
    await post(P(19), 'b2'); // they blocked v
    await post(P(20), 'v'); // v's own
    await post(P(21), 'm', { association: E2 }); // a followed entity
    await post(P(22), 'm', { association: E3 }); // v's own association
    await post(P(23), 'm', { association: EG }); // seen only through the read grant

    manager = {
      query: async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows,
    } as unknown as EntityManager;
  });

  afterAll(async () => {
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('suggests nothing to a reader who did not turn Suggestions on ("Nos principes")', async () => {
    expect(await suggested('m')).toEqual([]);
  });

  it("suggests popular posts of the viewer's space, the most engaged first", async () => {
    expect(SUGGESTED_POST_MIN_ENGAGED).toBe(3);
    // P2 has 5 engaged; P1 and P3 have 3 each, the newer first - P3 was written after P1.
    expect(await suggested()).toEqual([2, 3, 1]);
  });

  it('the viewer reads the follower-door and grant-door posts in their feeds, and is suggested neither', async () => {
    const { rows } = await q(`SELECT count(*)::int AS n FROM read_grants WHERE user_id = 'v'`);
    expect(rows[0].n).toBe(1);
    const ids = await suggested();
    expect(ids).not.toContain(17);
    expect(ids).not.toContain(23);
  });

  it('nothing from an author blocked either way, the viewer, an account or entity they follow or belong to', async () => {
    const ids = await suggested();
    for (const n of [15, 16, 18, 19, 20, 21, 22]) expect(ids).not.toContain(n);
  });

  it('nothing old, anonymous, hidden, scheduled, a reel, or under the engagement floor', async () => {
    const ids = await suggested();
    for (const n of [4, 10, 11, 12, 13, 14]) expect(ids).not.toContain(n);
  });

  it('a reader of another campus is suggested only what reaches their own space', async () => {
    // g (Gardanne) reads none of Saint-Etienne's posts; EG's reaches the Gardanne space, by its rule.
    expect(await suggested('g')).toEqual([23]);
  });

  it("unblocking makes the author's post a suggestion again; following them removes it", async () => {
    await q(`DELETE FROM user_blocks WHERE "blockerId" = 'v' AND "blockedId" = 'b1'`);
    expect(await suggested()).toContain(18);
    await follow('v', 'b1');
    expect(await suggested()).not.toContain(18);
  });
});
