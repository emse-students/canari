/**
 * THE AGENDA'S SPACE FILTER OPTIONS (owner, 2026-11-10) against a REAL PostgreSQL:
 * `AGENDA_REACHED_SPACES_SQL`, the read behind `GET associations/calendar/spaces`.
 *
 * What it proves:
 *  - a reader with one space gets ONE row (the frontend hides the filter);
 *  - an association merely visible through its rules adds nothing (a campus-wide association must
 *    not hand every student five formations);
 *  - a MEMBER of an association gets every space its rules address, plus their own;
 *  - a read grant gives the spaces of its ticked cell that some association addresses, and nothing
 *    outside the cell;
 *  - a reader with no space, membership or grant gets nothing;
 *  - EVERY returned space keeps at least one visible event under the feed's `campus` / `formation`
 *    narrowing (`eventVisibleToViewerSql` AND `eventReachesSpaceMatchingSql`): no option is dead.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `read-grants.integration.spec.ts`; locally, against any
 * throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- agenda-reached-spaces
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  AGENDA_REACHED_SPACES_SQL,
  eventReachesSpaceMatchingSql,
  eventVisibleToViewerSql,
} from './reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const A1 = '00000000-0000-4000-8000-0000000000a1'; // ICM x saint-etienne
const A2 = '00000000-0000-4000-8000-0000000000a2'; // the whole Gardanne campus
const A3 = '00000000-0000-4000-8000-0000000000a3'; // an institution addressing EVERYONE (NULL, NULL)
const E3 = '00000000-0000-4000-8000-0000000000e3'; // an event of A3
const E1 = '00000000-0000-4000-8000-0000000000e1'; // an event of A1
const E2 = '00000000-0000-4000-8000-0000000000e2'; // an event of A2

const USERS: Record<string, { campus: string | null; cursus: { formation: string }[] }> = {
  // One own space; A2 (whole Gardanne) is irrelevant to them, A1 is their own.
  icmSe: { campus: 'saint-etienne', cursus: [{ formation: 'ICM' }] },
  // A Gardanne student: A2's rule reaches them, and addresses five formations they are not in.
  isminGa: { campus: 'gardanne', cursus: [{ formation: 'ISMIN' }] },
  // No space of their own; a member of both associations (a BDE-like role).
  member: { campus: null, cursus: [] },
  // No space; a grant ticking the whole Gardanne campus.
  grantGa: { campus: null, cursus: [] },
  // No space; a grant ticking a cell no association addresses (ISMIN x saint-etienne).
  grantNone: { campus: null, cursus: [] },
  // No space; a grant over TWO cells, each addressed by a different association.
  grantTwo: { campus: null, cursus: [] },
  // An ICM x saint-etienne student who joined A2, an association of another space (D21).
  joiner: { campus: 'saint-etienne', cursus: [{ formation: 'ICM' }] },
  // No space, no membership, no grant (EMSE staff with an empty cursus).
  nobody: { campus: 'saint-etienne', cursus: [] },
};

const pairs = (rows: { formation: string; campus: string }[]) =>
  rows.map((r) => `${r.formation}@${r.campus}`).sort();

maybe('the agenda reached spaces against PostgreSQL', () => {
  const schema = `agenda_spaces_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const reached = async (userId: string) =>
    (await client.query(AGENDA_REACHED_SPACES_SQL, [userId])).rows as {
      formation: string;
      campus: string;
    }[];

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, formation varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "isBDE" boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, anonymous boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now(),
        "reachPublic" varchar(16), "reachSpaces" jsonb);
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
      [A3, 'School'],
    ]) {
      await client.query(`INSERT INTO associations (id, name) VALUES ($1, $2)`, [id, name]);
    }
    await client.query(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES
         ($1, 'ICM', 'saint-etienne'), ($2, NULL, 'gardanne'), ($3, NULL, NULL)`,
      [A1, A2, A3]
    );
    for (const [id, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.cursus),
      ]);
    }
    for (const a of [A1, A2]) {
      await client.query(
        `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'member')`,
        [a]
      );
    }
    // D21: a student who joined an association of another space, and one who joined the School.
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES
         ($1, 'joiner'), ($2, 'isminGa'), ($2, 'member')`,
      [A2, A3]
    );
    await client.query(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES
         ('grantGa', 'gardanne', NULL, 'admin'), ('grantNone', 'saint-etienne', 'ISMIN', 'admin'),
         ('grantTwo', 'saint-etienne', 'ICM', 'admin'), ('grantTwo', 'gardanne', 'ISMIN', 'admin')`
    );
    await client.query(
      `INSERT INTO association_calendar_events (id, "associationId") VALUES ($1, $4), ($2, $5), ($3, $6)`,
      [E1, E2, E3, A1, A2, A3]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('a reader with one space reaches one: the filter is hidden', async () => {
    expect(pairs(await reached('icmSe'))).toEqual(['ICM@saint-etienne']);
  });

  it('an institution speaking to EVERYONE (NULL, NULL) adds no space, member or not', async () => {
    // isminGa joined the School (A3): still one space. Nobody gets every option from A3.
    expect(pairs(await reached('isminGa'))).toEqual(['ISMIN@gardanne']);
  });

  it('a student who joined an association of another space reaches its spaces too (D21)', async () => {
    expect(pairs(await reached('joiner'))).toEqual(
      ['Autre', 'FSSS', 'ICM', 'ISMIN', 'PDIS']
        .map((f) => `${f}@gardanne`)
        .concat('ICM@saint-etienne')
        .sort()
    );
  });

  it('a read grant over two cells gives both addressed spaces', async () => {
    expect(pairs(await reached('grantTwo'))).toEqual(['ICM@saint-etienne', 'ISMIN@gardanne']);
  });

  it('an association merely visible through its rules adds no space', async () => {
    // A2 addresses the whole Gardanne campus and reaches this student, yet only theirs counts.
    expect(pairs(await reached('isminGa'))).toEqual(['ISMIN@gardanne']);
  });

  it("a member gets every space of their associations' rules", async () => {
    expect(pairs(await reached('member'))).toEqual(
      ['Autre', 'FSSS', 'ICM', 'ISMIN', 'PDIS']
        .map((f) => `${f}@gardanne`)
        .concat('ICM@saint-etienne')
        .sort()
    );
  });

  it('a read grant gives the addressed spaces of its cell, and nothing outside it', async () => {
    const spaces = pairs(await reached('grantGa'));
    expect(spaces).toHaveLength(5);
    expect(spaces.every((s) => s.endsWith('@gardanne'))).toBe(true);
  });

  it('a grant on a cell no association addresses reaches nothing', async () => {
    expect(await reached('grantNone')).toEqual([]);
  });

  it('a reader with no space, membership or grant reaches nothing', async () => {
    expect(await reached('nobody')).toEqual([]);
  });

  it('every returned space keeps at least one visible event under the narrowing', async () => {
    let checked = 0;
    for (const userId of ['icmSe', 'isminGa', 'member', 'grantGa', 'grantTwo', 'joiner']) {
      for (const space of await reached(userId)) {
        // The narrowings the filter offers (a campus, a formation) and the strict pair.
        const narrowings = [
          { filter: { campus: '$2', formation: null }, values: [space.campus] },
          { filter: { campus: null, formation: '$2' }, values: [space.formation] },
          { filter: { campus: '$2', formation: '$3' }, values: [space.campus, space.formation] },
        ];
        for (const { filter, values } of narrowings) {
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM association_calendar_events e
               WHERE ${eventVisibleToViewerSql('e', '$1')}
                 AND ${eventReachesSpaceMatchingSql('e', filter)}`,
            [userId, ...values]
          );
          expect({ userId, space, filter, kept: rows[0].n > 0 }).toEqual({
            userId,
            space,
            filter,
            kept: true,
          });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
