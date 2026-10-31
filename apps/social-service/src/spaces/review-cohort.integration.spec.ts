// FIRST, before reader-spaces: it sets the cohort the import-time fragments are built with.
import { REVIEW_A, REVIEW_B } from './review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  assertRosterStaysOnOneSide,
  associationsReachedByReviewer,
} from '../associations/review-cohort-reach';
import { ReviewCohortBoundaryException } from '../review-cohort';
import {
  IN_FEED_AUDIENCE_SQL,
  READER_SPACES_SQL,
  announceRecipientsSql,
  liveVisibleToUserSql,
  postVisibleToViewerSql,
  readerSpaces,
  reviewCohortAuthorFilterSql,
  type SpacePair,
} from './reader-spaces';

/**
 * THE REVIEW COHORT AGAINST A REAL PostgreSQL (`review-cohort.ts`): the store reviewers' accounts
 * share a space of their own and reach no real one, whatever their profile - so a reviewer reads
 * only the cohort, and a member never reads the cohort, for posts, lives, the feed gate and the
 * announcements alike.
 *
 * Review account A carries a student profile naming a real space - the case the rule must hold for
 * without anybody editing a profile - and B has none at all. The profile is the fixture's, the same
 * one the member has, and says nothing about any real account.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `reader-spaces.integration.spec.ts`, whose setup this
 * one trims to the tables these fragments read.
 */
const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const MEMBER = 'icmSe';
const ADMIN = 'admin';
const USERS: Record<string, { campus: string | null; cursus: unknown[]; admin?: boolean }> = {
  [REVIEW_A]: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2024 }] },
  [REVIEW_B]: { campus: null, cursus: [] },
  [MEMBER]: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2023 }] },
  [ADMIN]: { campus: null, cursus: [], admin: true },
};
const EVERYONE = Object.keys(USERS);

/** Created before 071, so the migration gives it (ICM, saint-etienne): A's profile would reach it. */
const A1 = '00000000-0000-4000-8000-0000000000a1';

const POSTS = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    label: "B's personal post",
    author: REVIEW_B,
    association: null,
    seenBy: [REVIEW_A, REVIEW_B],
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    label: "A's personal post",
    author: REVIEW_A,
    association: null,
    seenBy: [REVIEW_A, REVIEW_B],
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    label: "a member's personal post, in the space A's profile names",
    author: MEMBER,
    association: null,
    seenBy: [MEMBER],
  },
  {
    id: '00000000-0000-4000-8000-000000000104',
    label: 'an association post reaching the space A profile names',
    author: MEMBER,
    association: A1,
    seenBy: [MEMBER],
  },
];

const LIVES = [
  {
    id: '00000000-0000-4000-8000-000000000201',
    label: "B's live",
    broadcaster: REVIEW_B,
    seenBy: [REVIEW_A, REVIEW_B],
  },
  {
    id: '00000000-0000-4000-8000-000000000202',
    label: "a member's live",
    broadcaster: MEMBER,
    seenBy: [MEMBER],
  },
];

maybe('the review cohort against PostgreSQL', () => {
  const schema = `cohort_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, formation varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
      CREATE TABLE lives (id uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
    `);
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'A1')`, [A1]);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '074_coorganise.sql',
      '078_read_grants.sql',
    ]) {
      await client.query(migration(name));
    }
    for (const [id, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, admin, campus, cursus) VALUES ($1, $2, $3, $4)`, [
        id,
        u.admin ?? false,
        u.campus,
        JSON.stringify(u.cursus),
      ]);
    }
    // Both A and the member follow B: only A may be told that B published. And A follows the
    // member - a follow written before the rule, which must tell A nothing either.
    await client.query(`INSERT INTO user_follows VALUES ($1, $2), ($3, $2), ($1, $3)`, [
      REVIEW_A,
      REVIEW_B,
      MEMBER,
    ]);
    // 114 records every follow present when it runs as accepted.
    await client.query(migration('114_user_follow_status.sql'));
    for (const p of POSTS) {
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId") VALUES ($1, $2, $3)`,
        [p.id, p.author, p.association]
      );
    }
    for (const l of LIVES) {
      await client.query(`INSERT INTO lives (id, "broadcasterId") VALUES ($1, $2)`, [
        l.id,
        l.broadcaster,
      ]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('gives a review account no space, whatever its profile - in SQL and in the pure twin', async () => {
    const all = (await client.query(`SELECT formation, campus FROM spaces`)).rows as SpacePair[];
    for (const id of [REVIEW_A, REVIEW_B]) {
      expect((await client.query(READER_SPACES_SQL, [id])).rows).toEqual([]);
      expect(readerSpaces({ id, ...USERS[id] }, all)).toEqual([]);
    }
    expect((await client.query(READER_SPACES_SQL, [MEMBER])).rows).toEqual([
      { formation: 'ICM', campus: 'saint-etienne' },
    ]);
  });

  it('opens the feed to a review account: the cohort is a space of its own', async () => {
    for (const id of EVERYONE) {
      const { rows } = await client.query(IN_FEED_AUDIENCE_SQL, [id]);
      expect({ id, inAudience: rows[0].inAudience }).toEqual({ id, inAudience: true });
    }
  });

  it.each(POSTS.map((p) => [p.label, p] as const))('%s: exactly its readers', async (_l, post) => {
    const seen: string[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${postVisibleToViewerSql('posts', '$2')} AS visible FROM posts WHERE posts.id = $1`,
        [post.id, id]
      );
      if (rows[0].visible === true) seen.push(id);
    }
    expect(seen.sort()).toEqual([...post.seenBy].sort());
  });

  it.each(LIVES.map((l) => [l.label, l] as const))('%s: exactly its viewers', async (_l, live) => {
    const seen: string[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${liveVisibleToUserSql('lives', 'viewer')} AS visible
           FROM lives JOIN users viewer ON viewer.id = $2 WHERE lives.id = $1`,
        [live.id, id]
      );
      if (rows[0].visible === true) seen.push(id);
    }
    expect(seen.sort()).toEqual([...live.seenBy].sort());
  });

  it("announces a review account's post to its followers in the cohort, never to a member", async () => {
    const { rows } = await client.query(announceRecipientsSql(true), [POSTS[0].id]);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([REVIEW_A]);
  });

  it("announces a member's post to its followers outside the cohort, never to a review account", async () => {
    const { rows } = await client.query(announceRecipientsSql(true), [POSTS[2].id]);
    expect(rows.map((r: { id: string }) => r.id)).not.toContain(REVIEW_A);
  });

  it('lets an admin open a review account live by its id - moderation needs it - and nobody else', async () => {
    const seen: string[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${liveVisibleToUserSql('lives', 'viewer', { adminSeesCohort: true })} AS visible
           FROM lives JOIN users viewer ON viewer.id = $2 WHERE lives.id = $1`,
        [LIVES[0].id, id]
      );
      if (rows[0].visible === true) seen.push(id);
    }
    expect(seen.sort()).toEqual([ADMIN, REVIEW_A, REVIEW_B].sort());
  });

  it("keeps a review account's posts out of a member's feed and search by author, not an admin's or the cohort's", async () => {
    const shown = async (isAdmin: boolean, viewer: string) =>
      (
        await client.query(
          `SELECT id FROM posts WHERE true ${reviewCohortAuthorFilterSql(isAdmin, viewer)}`
        )
      ).rows
        .map((r: { id: string }) => r.id)
        .sort();
    const all = POSTS.map((p) => p.id).sort();
    const members = POSTS.filter((p) => p.author === MEMBER)
      .map((p) => p.id)
      .sort();
    expect(await shown(false, MEMBER)).toEqual(members);
    expect(await shown(true, ADMIN)).toEqual(all);
    expect(await shown(false, REVIEW_A)).toEqual(all);
  });

  it('closes every real association to a review account, and none to a member', async () => {
    const A2 = '00000000-0000-4000-8000-0000000000a2';
    const manager = {
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
    };
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2), ($3, $4)`,
      [A1, MEMBER, A2, REVIEW_B]
    );
    try {
      expect(await associationsReachedByReviewer(manager, REVIEW_B, [A1, A2])).toEqual(
        new Set([A2])
      );
      expect(await associationsReachedByReviewer(manager, REVIEW_A, [A1, A2])).toEqual(new Set());
      expect(await associationsReachedByReviewer(manager, MEMBER, [A1, A2])).toBeNull();
    } finally {
      await client.query(`DELETE FROM association_members WHERE "associationId" IN ($1, $2)`, [
        A1,
        A2,
      ]);
    }
  });

  it('never makes a review account a member of a real association, nor a member of the cohort one', async () => {
    const A3 = '00000000-0000-4000-8000-0000000000a3';
    const manager = {
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
    };
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`,
      [A1, MEMBER]
    );
    try {
      await expect(assertRosterStaysOnOneSide(manager, A1, REVIEW_A)).rejects.toBeInstanceOf(
        ReviewCohortBoundaryException
      );
      await expect(assertRosterStaysOnOneSide(manager, A1, ADMIN)).resolves.toBeUndefined();
      // An empty roster takes its first member, whichever side: the cohort's association starts so.
      await expect(assertRosterStaysOnOneSide(manager, A3, REVIEW_B)).resolves.toBeUndefined();
      await client.query(
        `INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`,
        [A3, REVIEW_B]
      );
      await expect(assertRosterStaysOnOneSide(manager, A3, MEMBER)).rejects.toBeInstanceOf(
        ReviewCohortBoundaryException
      );
      await expect(assertRosterStaysOnOneSide(manager, A3, REVIEW_A)).resolves.toBeUndefined();
    } finally {
      await client.query(`DELETE FROM association_members WHERE "associationId" IN ($1, $2)`, [
        A1,
        A3,
      ]);
    }
  });

  it('never opens a real association to a review account by a read grant', async () => {
    const assoPost = POSTS[3];
    await client.query(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by)
       VALUES ($1, 'saint-etienne', NULL, $2), ($3, 'saint-etienne', NULL, $2)`,
      [REVIEW_B, ADMIN, ADMIN]
    );
    try {
      const visible = async (viewer: string) =>
        (
          await client.query(
            `SELECT ${postVisibleToViewerSql('posts', '$2')} AS visible FROM posts WHERE posts.id = $1`,
            [assoPost.id, viewer]
          )
        ).rows[0].visible;
      expect(await visible(REVIEW_B)).toBe(false);
      // The same grant still opens it to the admin outside the cohort - the grant itself works.
      expect(await visible(ADMIN)).toBe(true);
    } finally {
      await client.query(`DELETE FROM read_grants`);
    }
  });
});
