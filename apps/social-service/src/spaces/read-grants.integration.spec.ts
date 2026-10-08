/**
 * NOMINATIVE READ GRANTS (WP7) against a REAL PostgreSQL - migrations 071 to 074 and 078 included.
 *
 * What it proves, and nothing more than the user's decisions of 2026-10-07 say:
 *  - a named reader sees the posts of the associations, lists AND institutions whose audience
 *    reaches a space inside a ticked cell (the whole campus, or one formation), the events of those
 *    associations too;
 *  - NEVER a personal post, whoever wrote it and wherever;
 *  - a cell reaching no association shows nothing, and a reader with no grant sees exactly what
 *    they saw before;
 *  - a grant NEVER notifies: the announcement recipients and the republication's newly reached
 *    readers are computed without it;
 *  - the directory and the anonymous agenda selection are NOT widened;
 *  - a revocation takes effect on the next read.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `reader-spaces.integration.spec.ts` and for its reason: CI
 * provides no database here, so the file reports as skipped rather than passing. Run it against any
 * throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- read-grants.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  IN_FEED_AUDIENCE_SQL,
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  announceRecipientsSql,
  associationVisibleToViewerSql,
  eventReachesSpaceMatchingSql,
  eventVisibleToViewerSql,
  postVisibleToViewerSql,
} from './reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

/** The cast: students, a poster (author of every entity post) and four named readers. */
const USERS = {
  icmSe: { campus: 'saint-etienne', cursus: [{ formation: 'ICM', promo: 2023 }] },
  isminGa: { campus: 'gardanne', cursus: [{ formation: 'ISMIN', promo: 2023 }] },
  outsider: { campus: 'saint-etienne', cursus: [] },
  poster: { campus: null, cursus: [] },
  // Named readers: no campus, no cursus - so no space, only a grant.
  grantGa: { campus: null, cursus: [] },
  grantIcmSe: { campus: null, cursus: [] },
  grantNone: { campus: null, cursus: [] },
  grantBoth: { campus: null, cursus: [] },
} as const;
type UserId = keyof typeof USERS;
const EVERYONE = Object.keys(USERS) as UserId[];

/** (campus, formation) cells; a null formation is the whole campus. */
const GRANTS: Record<string, [string, string | null][]> = {
  grantGa: [['gardanne', null]],
  grantIcmSe: [['saint-etienne', 'ICM']],
  // ISMIN x Saint-Etienne is a real space, but no association below addresses it.
  grantNone: [['saint-etienne', 'ISMIN']],
  grantBoth: [
    ['saint-etienne', 'ICM'],
    ['gardanne', null],
  ],
};

const A1 = '00000000-0000-4000-8000-0000000000a1'; // association (ICM, saint-etienne)
const A2 = '00000000-0000-4000-8000-0000000000a2'; // association (NULL, gardanne)
const I_ALL = '00000000-0000-4000-8000-0000000000c1'; // institution addressing everyone (the School)
const I_GA = '00000000-0000-4000-8000-0000000000c2'; // institution of the Gardanne campus

const RULES: [string, string | null, string | null][] = [
  [A1, 'ICM', 'saint-etienne'],
  [A2, null, 'gardanne'],
  [I_ALL, null, null],
  [I_GA, null, 'gardanne'],
];

const GRANTEES: UserId[] = ['grantGa', 'grantIcmSe', 'grantNone', 'grantBoth'];

const POSTS: {
  id: string;
  label: string;
  authorId: UserId;
  associationId: string | null;
  republishedBy?: string[];
  seenBy: UserId[];
}[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'an ICM x Saint-Etienne association post: its ticked cells and nobody else',
    authorId: 'poster',
    associationId: A1,
    seenBy: ['icmSe', 'poster', 'grantIcmSe', 'grantBoth'],
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    label: 'a whole-Gardanne association post',
    authorId: 'poster',
    associationId: A2,
    seenBy: ['isminGa', 'poster', 'grantGa', 'grantBoth'],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'an institution addressing everyone: every named reader whose cell holds a space',
    authorId: 'poster',
    associationId: I_ALL,
    seenBy: ['icmSe', 'isminGa', 'poster', ...GRANTEES],
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    label: 'a PERSONAL post of a Saint-Etienne student: never a named reader',
    authorId: 'icmSe',
    associationId: null,
    seenBy: ['icmSe'],
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    label: 'a PERSONAL post of a Gardanne student: never a named reader, even of Gardanne',
    authorId: 'isminGa',
    associationId: null,
    seenBy: ['isminGa'],
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    label: 'a Gardanne post republished by A1: its own cell and the republisher cell',
    authorId: 'poster',
    associationId: A2,
    republishedBy: [A1],
    seenBy: ['isminGa', 'icmSe', 'poster', 'grantGa', 'grantIcmSe', 'grantBoth'],
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    label: 'an institution of the Gardanne campus: seen by a grantee ticking Gardanne',
    authorId: 'poster',
    associationId: I_GA,
    seenBy: ['isminGa', 'poster', 'grantGa', 'grantBoth'],
  },
];

maybe('nominative read grants against PostgreSQL (migration 078 included)', () => {
  const schema = `grants_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const seenBy = async (postId: string): Promise<UserId[]> => {
    const seen: UserId[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${postVisibleToViewerSql('posts', '$2')} AS visible FROM posts WHERE posts.id = $1`,
        [postId, id]
      );
      if (rows[0].visible === true) seen.push(id);
    }
    return seen.sort();
  };

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
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '074_coorganise.sql',
      '078_read_grants.sql',
    ]) {
      await client.query(migration(name));
    }
    for (const [id, name] of [
      [A1, 'A1'],
      [A2, 'A2'],
      [I_ALL, 'School'],
      [I_GA, 'ME Gardanne'],
    ]) {
      await client.query(`INSERT INTO associations (id, name) VALUES ($1, $2)`, [id, name]);
    }
    for (const [association, formation, campus] of RULES) {
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [association, formation, campus]
      );
    }
    for (const [id, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.cursus),
      ]);
    }
    for (const [userId, cells] of Object.entries(GRANTS)) {
      for (const [campus, formation] of cells) {
        await client.query(
          `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ($1, $2, $3, 'admin')`,
          [userId, campus, formation]
        );
      }
    }
    for (const p of POSTS) {
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId") VALUES ($1, $2, $3)`,
        [p.id, p.authorId, p.associationId]
      );
      for (const by of p.republishedBy ?? []) {
        await client.query(
          `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'it')`,
          [p.id, by]
        );
      }
    }
    await client.query(
      `INSERT INTO association_calendar_events (id, "associationId") VALUES
         ('00000000-0000-4000-8000-0000000000e1', $1), ('00000000-0000-4000-8000-0000000000e2', $2)`,
      [A1, A2]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it.each(POSTS.map((p) => [p.label, p] as const))('%s', async (_label, post) => {
    expect(await seenBy(post.id)).toEqual([...post.seenBy].sort());
  });

  it('NO personal post is ever visible to a named reader, whoever wrote it', async () => {
    const personal = POSTS.filter((p) => p.associationId === null);
    expect(personal.length).toBeGreaterThan(0);
    for (const post of personal) {
      for (const id of GRANTEES) {
        const { rows } = await client.query(
          `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true })} AS visible
             FROM posts WHERE posts.id = $1`,
          [post.id, id]
        );
        expect({ reader: id, post: post.label, visible: rows[0].visible }).toEqual({
          reader: id,
          post: post.label,
          visible: false,
        });
      }
    }
  });

  it('a reader with no grant sees exactly what they saw before', async () => {
    // The same matrix computed with the grants table emptied for the duration.
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM read_grants`);
      const without: Record<string, string[]> = {};
      for (const id of EVERYONE) {
        const { rows } = await client.query(
          `SELECT posts.id FROM posts WHERE ${postVisibleToViewerSql('posts', '$1')} ORDER BY posts.id`,
          [id]
        );
        without[id] = rows.map((r) => r.id as string);
      }
      for (const id of ['icmSe', 'isminGa', 'outsider', 'poster'] as const) {
        const expected = POSTS.filter((p) => p.seenBy.includes(id)).map((p) => p.id);
        expect({ id, posts: without[id] }).toEqual({ id, posts: expected });
      }
      // And the four named readers see nothing at all once the grants are gone.
      for (const id of GRANTEES) expect({ id, posts: without[id] }).toEqual({ id, posts: [] });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('the feed gate admits a named reader who has no space and no membership', async () => {
    const admitted: string[] = [];
    for (const id of EVERYONE) {
      const { rows } = await client.query(IN_FEED_AUDIENCE_SQL, [id]);
      if (rows[0].inAudience === true) admitted.push(id);
    }
    expect(admitted.sort()).toEqual([
      'grantBoth',
      'grantGa',
      'grantIcmSe',
      'grantNone',
      'icmSe',
      'isminGa',
    ]);
  });

  it('the signed-in agenda carries the events of the ticked associations only', async () => {
    const seen: Record<string, string[]> = {};
    for (const id of EVERYONE) {
      const { rows } = await client.query(
        `SELECT e.id FROM association_calendar_events e WHERE ${eventVisibleToViewerSql('e', '$1')} ORDER BY e.id`,
        [id]
      );
      seen[id] = rows.map((r) => ((r.id as string).endsWith('e1') ? 'E1' : 'E2'));
    }
    expect(seen).toEqual({
      icmSe: ['E1'],
      isminGa: ['E2'],
      outsider: [],
      poster: [],
      grantGa: ['E2'],
      grantIcmSe: ['E1'],
      grantNone: [],
      grantBoth: ['E1', 'E2'],
    });
  });

  it('a grant NEVER notifies: announcements and republications are computed without it', async () => {
    const gardanne = await client.query(announceRecipientsSql(false), [POSTS[1].id]);
    expect(gardanne.rows.map((r) => r.id as string)).toEqual(['isminGa']);
    const everyone = await client.query(announceRecipientsSql(false), [POSTS[2].id]);
    expect(everyone.rows.map((r) => r.id as string).sort()).toEqual(['icmSe', 'isminGa']);
    // A1's post republished by A2 would newly reach Gardanne readers - isminGa, not grantGa/grantBoth.
    const newly = await client.query(NEWLY_REACHED_BY_REPUBLICATION_SQL, [POSTS[0].id, A2]);
    expect(newly.rows.map((r) => r.id as string)).toEqual(['isminGa']);
  });

  it('the directory and the anonymous selection are not widened by a grant', async () => {
    for (const id of GRANTEES) {
      const { rows } = await client.query(
        `SELECT a.name FROM associations a WHERE ${associationVisibleToViewerSql('a.id', '$1')}`,
        [id]
      );
      expect({ id, directory: rows }).toEqual({ id, directory: [] });
    }
    // The anonymous agenda per selection has no reader at all, so no grant can enter it.
    expect(eventReachesSpaceMatchingSql('e', { campus: '$1', formation: null })).not.toContain(
      'read_grants'
    );
  });

  it('a revocation takes effect on the next read, and a grant on the next as well', async () => {
    await client.query('BEGIN');
    try {
      expect(await seenBy(POSTS[1].id)).toContain('grantGa');
      await client.query(`DELETE FROM read_grants WHERE user_id = 'grantGa'`);
      expect(await seenBy(POSTS[1].id)).not.toContain('grantGa');
      await client.query(
        `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('grantGa', 'gardanne', 'ISMIN', 'admin')`
      );
      // One formation of the campus is enough for a rule addressing the whole campus.
      expect(await seenBy(POSTS[1].id)).toContain('grantGa');
      // ... but a formation no rule of A1 reaches shows nothing of A1.
      expect(await seenBy(POSTS[0].id)).not.toContain('grantGa');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a cell is granted once: the unique key treats a NULL formation as a value', async () => {
    await expect(
      client.query(
        `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('grantGa', 'gardanne', NULL, 'admin')`
      )
    ).rejects.toThrow(/uq_read_grants_cell/);
  });

  it('the migration is idempotent', async () => {
    await client.query(migration('078_read_grants.sql'));
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM read_grants`);
    expect(rows[0].n).toBe(5);
  });
});
