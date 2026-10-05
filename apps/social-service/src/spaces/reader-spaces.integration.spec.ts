/**
 * WHO SEES WHAT (WP6b), against a REAL PostgreSQL - migration 071 included.
 *
 * `reader-spaces.spec.ts` proves the pure functions and `posts.service.visibility.spec.ts` the
 * wiring; neither proves anything about the SQL. This file runs every fragment of
 * `reader-spaces.ts` against a cast of readers and posts and asserts exactly who sees what: the
 * feed gate, each post, the announce recipients, the agenda's association predicate - and that
 * `READER_SPACES_SQL` and the pure `readerSpaces` answer the same for every reader.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `reel-retention.integration.spec.ts` and for its reason:
 * CI provides no database here, and the whole file reports as skipped rather than passing. Run it
 * against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- reader-spaces.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. The tables other services own
 * (`users`, `associations`, `posts`, ...) are built with only the columns these fragments read.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  IN_FEED_AUDIENCE_SQL,
  READER_SPACES_SQL,
  announceRecipientsSql,
  associationRulesReachSpaceMatchingSql,
  associationVisibleToViewerSql,
  postVisibleToViewerSql,
  readerSpaces,
  type SpacePair,
} from './reader-spaces';
import { smallestRules } from './spaces.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '071_spaces.sql'), 'utf8');
const MIGRATION_072 = readFileSync(
  join(__dirname, '..', 'migrations', '072_drop_is_bde.sql'),
  'utf8'
);

/** The cast. Ids are readable on purpose: a failure names a person, not a uuid. */
const USERS = {
  icmSe: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2023 }] },
  icmSe2: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2024 }] },
  isminGa: { campus: 'gardanne', cursus: [{ formation: 'ISMIN', promo: 2023 }] },
  // A global admin with no space: browsing shows them only what they wrote.
  admin: { campus: null, cursus: [], admin: true },
  // An admin who is also an ICM student: sees what an ICM student sees, no more.
  adminIcm: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2022 }], admin: true },
  // Staff: a post at the School, no cursus - so no space at all. Member of A1.
  staff: { campus: 'saint-etienne', cursus: [] },
  // Campus but no cursus, and no membership: the one reader the gate refuses.
  outsider: { campus: 'saint-etienne', cursus: [] },
  // A profile not backfilled yet (WP3): what production users look like before the backfill.
  notBackfilled: { campus: null, cursus: [] },
} as const;
type UserId = keyof typeof USERS;

const A1 = '00000000-0000-4000-8000-0000000000a1'; // (ICM, saint-etienne), member: staff
const A2 = '00000000-0000-4000-8000-0000000000a2'; // (NULL, gardanne): the whole campus

/** Posts, with who must see each - the whole matrix of decision 3. */
const POSTS: {
  id: string;
  label: string;
  authorId: UserId;
  associationId: string | null;
  anonymous?: boolean;
  ownRules?: { formation: string | null; campus: string | null }[];
  seenBy: UserId[];
}[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'an A1 post (its rules reach ICM x saint-etienne; staff is a member AND the author)',
    authorId: 'staff',
    associationId: A1,
    seenBy: ['icmSe', 'icmSe2', 'adminIcm', 'staff'],
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    label: 'an A2 post (the whole Gardanne campus)',
    authorId: 'admin',
    associationId: A2,
    seenBy: ['isminGa', 'admin'],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'an A2 post narrowed by its own rule to ICM x gardanne (nobody in the cast)',
    authorId: 'admin',
    associationId: A2,
    ownRules: [{ formation: 'ICM', campus: 'gardanne' }],
    seenBy: ['admin'],
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    label: 'an A1 post whose stored rule is OUTSIDE the ceiling (ISMIN x gardanne): held at read',
    authorId: 'staff',
    associationId: A1,
    ownRules: [{ formation: 'ISMIN', campus: 'gardanne' }],
    seenBy: ['staff'],
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    label: 'a personal post (its author shares ICM x saint-etienne)',
    authorId: 'icmSe',
    associationId: null,
    seenBy: ['icmSe', 'icmSe2', 'adminIcm'],
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    label: 'an anonymous personal post from Gardanne',
    authorId: 'isminGa',
    associationId: null,
    anonymous: true,
    seenBy: ['isminGa'],
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    label: 'a personal post by staff, who has no space (D31): only its author',
    authorId: 'staff',
    associationId: null,
    seenBy: ['staff'],
  },
];

const EVERYONE = Object.keys(USERS) as UserId[];

maybe('reader spaces against PostgreSQL (migration 071 included)', () => {
  const schema = `spaces_it_${Math.random().toString(36).slice(2, 10)}`;
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
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255));
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "associationId" uuid);
    `);
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'A1'), ($2, 'A2')`, [
      A1,
      A2,
    ]);
    // The migration as it ships: seeds the ten pairs and gives EVERY association (ICM, SE).
    await client.query(MIGRATION);
    // 071 reads `isBDE`, which 072 then drops: the shape production goes through (WP6c).
    await client.query(MIGRATION_072);
    // Then the grid: A2 addresses the whole Gardanne campus instead.
    await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [A2]);
    await client.query(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
      [A2]
    );
    for (const [id, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, admin, campus, cursus) VALUES ($1, $2, $3, $4)`, [
        id,
        'admin' in u ? u.admin : false,
        u.campus,
        JSON.stringify(u.cursus),
      ]);
    }
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'staff')`,
      [A1]
    );
    await client.query(
      `INSERT INTO user_follows VALUES ('icmSe2', 'icmSe'), ('isminGa', 'icmSe'), ('outsider', 'icmSe')`
    );
    for (const p of POSTS) {
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId", anonymous) VALUES ($1, $2, $3, $4)`,
        [p.id, p.authorId, p.associationId, p.anonymous ?? false]
      );
      for (const r of p.ownRules ?? []) {
        await client.query(
          `INSERT INTO post_audiences ("postId", formation, campus) VALUES ($1, $2, $3)`,
          [p.id, r.formation, r.campus]
        );
      }
    }
    await client.query(
      `INSERT INTO association_calendar_events ("associationId") VALUES ($1), ($2)`,
      [A1, A2]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('READER_SPACES_SQL and readerSpaces agree for every reader', async () => {
    const all = (await client.query(`SELECT formation, campus FROM spaces`)).rows as SpacePair[];
    expect(all).toHaveLength(10);
    const key = (s: SpacePair) => `${s.formation}|${s.campus}`;
    for (const [id, u] of Object.entries(USERS)) {
      const sql = (await client.query(READER_SPACES_SQL, [id])).rows as SpacePair[];
      const pure = readerSpaces({ campus: u.campus, cursus: u.cursus }, all);
      expect({ id, spaces: sql.map(key).sort() }).toEqual({ id, spaces: pure.map(key).sort() });
    }
    // And the answer is what D16 says, not merely the same in both.
    const icm = (await client.query(READER_SPACES_SQL, ['icmSe'])).rows;
    expect(icm).toEqual([{ formation: 'ICM', campus: 'saint-etienne' }]);
  });

  it('the gate admits an admin, a reader with a space, and a member - and nobody else', async () => {
    const admitted: string[] = [];
    for (const id of [...EVERYONE, 'nobody-at-all']) {
      const { rows } = await client.query(IN_FEED_AUDIENCE_SQL, [id]);
      if (rows[0].inAudience === true) admitted.push(id);
    }
    expect(admitted.sort()).toEqual(['admin', 'adminIcm', 'icmSe', 'icmSe2', 'isminGa', 'staff']);
  });

  it.each(POSTS.map((p) => [p.label, p] as const))('%s', async (_label, post) => {
    const seen: UserId[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${postVisibleToViewerSql('posts', '$2')} AS visible FROM posts WHERE posts.id = $1`,
        [post.id, id]
      );
      if (rows[0].visible === true) seen.push(id);
    }
    expect(seen.sort()).toEqual([...post.seenBy].sort());
  });

  it('as a filter in a list, it returns each reader exactly their posts', async () => {
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT posts.id FROM posts WHERE true AND ${postVisibleToViewerSql('posts', '$1')} ORDER BY posts.id`,
        [id]
      );
      const expected = POSTS.filter((p) => p.seenBy.includes(id)).map((p) => p.id);
      expect({ id, posts: rows.map((r) => r.id as string) }).toEqual({ id, posts: expected });
    }
  });

  it('a global admin may open ANY post by its id, but browsing never shows it to them', async () => {
    for (const post of POSTS) {
      const { rows } = await client.query(
        `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true })} AS visible FROM posts WHERE posts.id = $1`,
        [post.id, 'admin']
      );
      expect({ post: post.label, openByIdAsAdmin: rows[0].visible }).toEqual({
        post: post.label,
        openByIdAsAdmin: true,
      });
    }
    const { rows } = await client.query(
      `SELECT posts.id FROM posts WHERE ${postVisibleToViewerSql('posts', '$1')} ORDER BY posts.id`,
      ['admin']
    );
    // Only what the admin wrote themselves: the posts of the two A2 rows.
    expect(rows.map((r) => r.id as string)).toEqual(
      POSTS.filter((p) => p.authorId === 'admin').map((p) => p.id)
    );
    // A non-admin never gets the opening by id.
    const outsider = await client.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true })} AS visible FROM posts WHERE posts.id = $1`,
      [POSTS[4].id, 'isminGa']
    );
    expect(outsider.rows[0].visible).toBe(false);
  });

  it('an absent viewer (NULL) sees nothing at all', async () => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM posts WHERE ${postVisibleToViewerSql('posts', '$1')}`,
      [null]
    );
    expect(rows[0].n).toBe(0);
  });

  it('announces a post to everyone who can see it, minus its author', async () => {
    const { rows } = await client.query(announceRecipientsSql(false), [POSTS[0].id]);
    expect(rows.map((r) => r.id as string).sort()).toEqual(['adminIcm', 'icmSe', 'icmSe2']);
  });

  it("announces a personal post to its author's followers who can see it, and no other", async () => {
    // Three follow icmSe; isminGa (Gardanne) and outsider (no space) cannot see the post.
    const { rows } = await client.query(announceRecipientsSql(true), [POSTS[4].id]);
    expect(rows.map((r) => r.id as string)).toEqual(['icmSe2']);
  });

  it('filters the agenda by the event association: rules, membership, admin', async () => {
    const seen: Record<string, string[]> = {};
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT e."associationId" FROM association_calendar_events e
          WHERE ${associationVisibleToViewerSql('e."associationId"', '$1')} ORDER BY e.id`,
        [id]
      );
      seen[id] = rows.map((r) => (r.associationId === A1 ? 'A1' : 'A2'));
    }
    expect(seen).toEqual({
      icmSe: ['A1'],
      icmSe2: ['A1'],
      isminGa: ['A2'],
      admin: [],
      adminIcm: ['A1'],
      staff: ['A1'],
      outsider: [],
      notBackfilled: [],
    });
  });

  it('lists each reader their directory (D37): rules or membership, an admin as anyone', async () => {
    const seen: Record<string, string[]> = {};
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT a.name FROM associations a
          WHERE true AND ${associationVisibleToViewerSql('a.id', '$1')} ORDER BY a.name`,
        [id]
      );
      seen[id] = rows.map((r) => r.name as string);
    }
    expect(seen).toEqual({
      icmSe: ['A1'],
      icmSe2: ['A1'],
      isminGa: ['A2'],
      admin: [],
      adminIcm: ['A1'],
      staff: ['A1'],
      outsider: [],
      notBackfilled: [],
    });
  });

  it.each([
    [{ campus: 'gardanne', formation: null }, ['A2']],
    [{ campus: 'saint-etienne', formation: null }, ['A1']],
    [{ campus: null, formation: 'ICM' }, ['A1', 'A2']],
    [{ campus: null, formation: 'ISMIN' }, ['A2']],
    [{ campus: 'saint-etienne', formation: 'ISMIN' }, []],
    [{ campus: null, formation: null }, ['A1', 'A2']],
  ] as const)('the map filter %j keeps %j', async (filter, expected) => {
    const params: string[] = [];
    const slot = (v: string | null) => (v === null ? null : `$${params.push(v)}`);
    const sql = associationRulesReachSpaceMatchingSql('a.id', {
      campus: slot(filter.campus),
      formation: slot(filter.formation),
    });
    const { rows } = await client.query(
      `SELECT a.name FROM associations a WHERE ${sql} ORDER BY a.name`,
      params
    );
    expect(rows.map((r) => r.name as string)).toEqual(expected);
  });

  it('an association with no rule is on no campus of the map', async () => {
    const lone = '00000000-0000-4000-8000-0000000000a9';
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'lone')`, [lone]);
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM associations a WHERE a.id = $1 AND ${associationRulesReachSpaceMatchingSql(
          'a.id',
          { campus: null, formation: null }
        )}`,
        [lone]
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await client.query(`DELETE FROM associations WHERE id = $1`, [lone]);
    }
  });

  it("a new association reaches exactly its creator's spaces (D36)", async () => {
    const created = '00000000-0000-4000-8000-0000000000a8';
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'new')`, [created]);
    try {
      // What `AssociationsService.create` writes, from the same two functions.
      for (const creator of ['isminGa', 'admin'] as const) {
        await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [
          created,
        ]);
        const spaces = (await client.query(READER_SPACES_SQL, [creator])).rows as SpacePair[];
        for (const r of smallestRules(spaces)) {
          await client.query(
            `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
            [created, r.formation, r.campus]
          );
        }
        const reached: string[] = [];
        for (const id of EVERYONE) {
          const { rows } = await client.query(
            `SELECT ${associationVisibleToViewerSql('$2', '$1')} AS v`,
            [id, created]
          );
          if (rows[0].v === true) reached.push(id);
        }
        // isminGa's spaces are ISMIN x gardanne; an admin with no space writes no rule at all.
        expect({ creator, reached }).toEqual({
          creator,
          reached: creator === 'isminGa' ? ['isminGa'] : [],
        });
      }
    } finally {
      await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [created]);
      await client.query(`DELETE FROM associations WHERE id = $1`, [created]);
    }
  });

  it('a cursus that is not an array matches nothing instead of failing every reader', async () => {
    await client.query(`UPDATE users SET cursus = '{"formation": "ICM"}' WHERE id = 'outsider'`);
    const { rows } = await client.query(IN_FEED_AUDIENCE_SQL, ['outsider']);
    expect(rows[0].inAudience).toBe(false);
    const list = await client.query(
      `SELECT count(*)::int AS n FROM posts WHERE ${postVisibleToViewerSql('posts', '$1')}`,
      ['outsider']
    );
    expect(list.rows[0].n).toBe(0);
  });
});
