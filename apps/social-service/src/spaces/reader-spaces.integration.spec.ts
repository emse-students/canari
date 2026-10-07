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
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  READER_SPACES_SQL,
  announceRecipientsSql,
  associationRulesReachSpaceMatchingSql,
  associationVisibleToViewerSql,
  eventReachesSpaceMatchingSql,
  eventVisibleToViewerSql,
  postVisibleToUserSql,
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
// Republication (D38): `post_republications`, `proposals`, and `post_audiences` dropped.
const MIGRATION_073 = readFileSync(
  join(__dirname, '..', 'migrations', '073_republications.sql'),
  'utf8'
);
// Co-organisation (D39): the `coorganise` kind, the co-owner unique key and the event trigger.
const MIGRATION_074 = readFileSync(
  join(__dirname, '..', 'migrations', '074_coorganise.sql'),
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
  // Member of A3, which reaches nobody by rule - so a member and nothing else.
  notBackfilled: { campus: null, cursus: [] },
} as const;
type UserId = keyof typeof USERS;

const A1 = '00000000-0000-4000-8000-0000000000a1'; // (ICM, saint-etienne), member: staff
const A2 = '00000000-0000-4000-8000-0000000000a2'; // (NULL, gardanne): the whole campus
const A3 = '00000000-0000-4000-8000-0000000000a3'; // created after 071: no rule, member notBackfilled

/** Posts, with who must see each - the whole matrix of decision 3, and of republication (D38). */
const POSTS: {
  id: string;
  label: string;
  authorId: UserId;
  associationId: string | null;
  anonymous?: boolean;
  republishedBy?: string[];
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
    label: 'an A2 post republished by A1: Gardanne, plus everyone A1 reaches and its member staff',
    authorId: 'admin',
    associationId: A2,
    republishedBy: [A1],
    seenBy: ['isminGa', 'admin', 'icmSe', 'icmSe2', 'adminIcm', 'staff'],
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    label: 'an A1 post republished by A3, which reaches nobody by rule: plus its member only (D21)',
    authorId: 'staff',
    associationId: A1,
    republishedBy: [A3],
    seenBy: ['icmSe', 'icmSe2', 'adminIcm', 'staff', 'notBackfilled'],
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

/** Agenda events (D39): an event reaches its organiser's audience plus each ACCEPTED co-organiser's. */
const EVENTS: {
  id: string;
  label: string;
  organiser: string;
  accepted?: string[];
  pending?: string[];
}[] = [
  { id: '00000000-0000-4000-8000-0000000000e1', label: 'E1', organiser: A1 },
  { id: '00000000-0000-4000-8000-0000000000e2', label: 'E2', organiser: A2 },
  // Co-organised by A3, accepted: A3's member (notBackfilled) sees it too.
  { id: '00000000-0000-4000-8000-0000000000e3', label: 'E3', organiser: A2, accepted: [A3] },
  // A1 is only ASKED: nothing of A1's audience sees it yet.
  { id: '00000000-0000-4000-8000-0000000000e4', label: 'E4', organiser: A2, pending: [A1] },
];

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
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
    `);
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'A1'), ($2, 'A2')`, [
      A1,
      A2,
    ]);
    // The migration as it ships: seeds the ten pairs and gives EVERY association (ICM, SE).
    await client.query(MIGRATION);
    // 071 reads `isBDE`, which 072 then drops: the shape production goes through (WP6c).
    await client.query(MIGRATION_072);
    await client.query(MIGRATION_073);
    await client.query(MIGRATION_074);
    // A3 is created after 071, so it has no rule: it reaches its members and nobody else.
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'A3')`, [A3]);
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
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'staff'), ($2, 'notBackfilled')`,
      [A1, A3]
    );
    await client.query(
      `INSERT INTO user_follows VALUES ('icmSe2', 'icmSe'), ('isminGa', 'icmSe'), ('outsider', 'icmSe')`
    );
    for (const p of POSTS) {
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId", anonymous) VALUES ($1, $2, $3, $4)`,
        [p.id, p.authorId, p.associationId, p.anonymous ?? false]
      );
      for (const by of p.republishedBy ?? []) {
        await client.query(
          `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'it')`,
          [p.id, by]
        );
      }
    }
    for (const ev of EVENTS) {
      await client.query(
        `INSERT INTO association_calendar_events (id, "associationId") VALUES ($1, $2)`,
        [ev.id, ev.organiser]
      );
      for (const co of ev.accepted ?? []) {
        await client.query(
          `INSERT INTO association_calendar_event_co_owners (event_id, association_id) VALUES ($1, $2)`,
          [ev.id, co]
        );
      }
      // A PENDING co-organiser is a proposal and nothing else: no co-owner row.
      for (const co of ev.pending ?? []) {
        await client.query(
          `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "proposedBy")
             VALUES ('coorganise', $1, $2, $3, 'it')`,
          [ev.id, ev.organiser, co]
        );
      }
    }
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
    expect(admitted.sort()).toEqual([
      'admin',
      'adminIcm',
      'icmSe',
      'icmSe2',
      'isminGa',
      'notBackfilled',
      'staff',
    ]);
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

  it('a republication newly reaches exactly who sees the post AFTER and not BEFORE (D38)', async () => {
    // POSTS[0] is A1's, seen by the ICM Saint-Etienne readers and staff. A2 reaching Gardanne would
    // add isminGa; nobody else gains it, and the author is never counted.
    const newly = await client.query(NEWLY_REACHED_BY_REPUBLICATION_SQL, [POSTS[0].id, A2]);
    expect(newly.rows.map((r) => r.id as string)).toEqual(['isminGa']);

    // Checked against the state itself: write the row, compare after with before, roll back.
    const visibleTo = async () =>
      (
        await client.query(
          `SELECT u.id FROM users u, posts WHERE posts.id = $1
             AND ${postVisibleToUserSql('posts', 'u')} ORDER BY u.id`,
          [POSTS[0].id]
        )
      ).rows.map((r) => r.id as string);
    const before = await visibleTo();
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'it')`,
        [POSTS[0].id, A2]
      );
      const after = await visibleTo();
      expect(after.filter((id) => !before.includes(id))).toEqual(['isminGa']);
      expect(before.every((id) => after.includes(id))).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }

    // Republished by its own audience's association again: nobody new.
    const none = await client.query(NEWLY_REACHED_BY_REPUBLICATION_SQL, [POSTS[3].id, A1]);
    expect(none.rows).toEqual([]);
  });

  it('a deleted post takes its republications and its repost proposals with it', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "proposedBy")
           VALUES ('repost', $1, $2, $3, 'staff')`,
        [POSTS[3].id, A1, A2]
      );
      await client.query(`DELETE FROM posts WHERE id = $1`, [POSTS[3].id]);
      const left = await client.query(
        `SELECT (SELECT count(*)::int FROM post_republications WHERE "postId" = $1) AS reps,
                (SELECT count(*)::int FROM proposals WHERE "subjectId" = $1) AS props`,
        [POSTS[3].id]
      );
      expect(left.rows[0]).toEqual({ reps: 0, props: 0 });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("announces a personal post to its author's followers who can see it, and no other", async () => {
    // Three follow icmSe; isminGa (Gardanne) and outsider (no space) cannot see the post.
    const { rows } = await client.query(announceRecipientsSql(true), [POSTS[4].id]);
    expect(rows.map((r) => r.id as string)).toEqual(['icmSe2']);
  });

  it('filters the agenda by organiser OR accepted co-organiser: rules, membership, admin', async () => {
    const seen: Record<string, string[]> = {};
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT e.id FROM association_calendar_events e
          WHERE ${eventVisibleToViewerSql('e', '$1')} ORDER BY e.id`,
        [id]
      );
      seen[id] = rows.map((r) => EVENTS.find((ev) => ev.id === r.id)?.label ?? '?');
    }
    expect(seen).toEqual({
      icmSe: ['E1'],
      icmSe2: ['E1'],
      isminGa: ['E2', 'E3', 'E4'],
      admin: [],
      adminIcm: ['E1'],
      staff: ['E1'],
      outsider: [],
      // A member of A3 and nothing else: the event A3 co-organises, never the one A3 was not asked to.
      notBackfilled: ['E3'],
    });
  });

  it.each([
    [{ campus: 'gardanne', formation: null }, ['E2', 'E3', 'E4']],
    [{ campus: 'saint-etienne', formation: null }, ['E1']],
    [{ campus: null, formation: 'ICM' }, ['E1', 'E2', 'E3', 'E4']],
    [{ campus: null, formation: 'ISMIN' }, ['E2', 'E3', 'E4']],
    [{ campus: 'saint-etienne', formation: 'ISMIN' }, []],
  ] as const)('the anonymous agenda selection %j keeps %j (D40)', async (filter, expected) => {
    const params: string[] = [];
    const slot = (v: string | null) => (v === null ? null : `$${params.push(v)}`);
    const sql = eventReachesSpaceMatchingSql('e', {
      campus: slot(filter.campus),
      formation: slot(filter.formation),
    });
    const { rows } = await client.query(
      `SELECT e.id FROM association_calendar_events e WHERE ${sql} ORDER BY e.id`,
      params
    );
    expect(rows.map((r) => EVENTS.find((ev) => ev.id === r.id)?.label)).toEqual(expected);
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
      // A member of A3 sees it in the directory: D37 lists what one belongs to, rules or not.
      notBackfilled: ['A3'],
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

  it('a change of audience applies to a POST ALREADY PUBLISHED: visibility follows the current rule (decision 4)', async () => {
    const post = '00000000-0000-4000-8000-0000000000b1';
    await client.query(
      `INSERT INTO posts (id, "authorId", "associationId") VALUES ($1, 'staff', $2)`,
      [post, A1]
    );
    const seenBy = async () => {
      const seen: string[] = [];
      for (const id of ['icmSe', 'isminGa']) {
        const { rows } = await client.query(
          `SELECT ${postVisibleToViewerSql('p', '$1')} AS v FROM posts p WHERE p.id = $2`,
          [id, post]
        );
        if (rows[0].v === true) seen.push(id);
      }
      return seen;
    };
    try {
      // A1 addresses ICM x saint-etienne: only the ICM student of Saint-Etienne reads it.
      expect(await seenBy()).toEqual(['icmSe']);
      // The audience moves to Gardanne: the SAME stored post now reaches the other reader instead.
      await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [A1]);
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
        [A1]
      );
      expect(await seenBy()).toEqual(['isminGa']);
    } finally {
      await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [A1]);
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ICM', 'saint-etienne')`,
        [A1]
      );
      await client.query(`DELETE FROM posts WHERE id = $1`, [post]);
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
