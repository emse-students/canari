/**
 * Migration 187 against a REAL PostgreSQL: every stored FSSS is respelt FISA IN PLACE (ids kept),
 * the second saint-etienne BDE is renamed only while it carries 130's exact name, a value that
 * merely CONTAINS the letters is left alone, the CHECKs end on the new list, and a second run
 * changes nothing.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (CI's
 * `test-social-integration` sets it and fails on a skipped test):
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- formation-fisa-migration.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '187_formation_fsss_is_fisa.sql'),
  'utf8'
);

const OLD = "('ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre')";
const SPACE_SE = '00000000-0000-4000-8000-000000000001';
const SPACE_ICM = '00000000-0000-4000-8000-000000000002';
const BDE_FSSS = '00000000-0000-4000-8000-0000000000b1';
const BDE_RENAMED = '00000000-0000-4000-8000-0000000000b2';

maybe('migration 187 against PostgreSQL (FSSS is FISA)', () => {
  const schema = `fisa_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  /** The single value of a one-row, one-column query. */
  async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await client.query(sql, params);
    return Object.values(rows[0] ?? {})[0] as T;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The minimal shape the migration touches, with the CHECKs 071 and 078 left on production.
    await client.query(`
      CREATE TABLE spaces (id uuid PRIMARY KEY, formation varchar(16) NOT NULL, campus varchar(32) NOT NULL,
        CONSTRAINT "CHK_spaces_formation" CHECK (formation IN ${OLD}));
      CREATE TABLE association_audiences (id serial PRIMARY KEY, formation varchar(16) NULL, campus varchar(32) NULL,
        CONSTRAINT "CHK_association_audiences_formation" CHECK (formation IS NULL OR formation IN ${OLD}));
      CREATE TABLE read_grants (id serial PRIMARY KEY, campus varchar(32) NOT NULL,
        formation varchar(16) NULL CHECK (formation IS NULL OR formation IN ${OLD}));
      CREATE TABLE agenda_subscriptions (id serial PRIMARY KEY, campus varchar(32) NULL,
        formation varchar(16) NULL, "associationId" uuid NULL, "selectionKey" varchar(96) NOT NULL);
      CREATE TABLE posts (id serial PRIMARY KEY, "reachSpaces" jsonb NULL);
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "reachSpaces" jsonb NULL);
      CREATE TABLE users (id varchar(255) PRIMARY KEY, formation varchar(32) NULL,
        cursus jsonb NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE users_pre_wp3 (id varchar(255) PRIMARY KEY, formation varchar(32) NULL);
      CREATE TABLE forms (id serial PRIMARY KEY, "priceMatrix" jsonb NULL, "submitCondition" jsonb NULL,
        items jsonb NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE association_products (id serial PRIMARY KEY, "priceMatrix" jsonb NULL);
      CREATE TABLE booking_spaces (id serial PRIMARY KEY, audience jsonb NULL, items jsonb NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE associations (id uuid PRIMARY KEY, slug varchar(255) NOT NULL, name varchar(255) NOT NULL);
    `);
    await client.query(
      `INSERT INTO spaces VALUES ($1, 'FSSS', 'saint-etienne'), ($2, 'ICM', 'saint-etienne')`,
      [SPACE_SE, SPACE_ICM]
    );
    await client.query(`
      INSERT INTO association_audiences (formation, campus) VALUES ('FSSS', 'saint-etienne'), (NULL, 'gardanne'), ('ICM', NULL);
      INSERT INTO read_grants (campus, formation) VALUES ('saint-etienne', 'FSSS'), ('gardanne', NULL);
      INSERT INTO agenda_subscriptions (campus, formation, "associationId", "selectionKey") VALUES
        ('saint-etienne', 'FSSS', NULL, 'saint-etienne|FSSS|-'), ('gardanne', 'ICM', NULL, 'gardanne|ICM|-');
      INSERT INTO posts ("reachSpaces") VALUES
        ('[{"formation":"ICM","campus":"saint-etienne"},{"formation":"FSSS","campus":"saint-etienne"},{"formation":"PDIS","campus":"gardanne"}]'),
        (NULL), ('[{"formation":"ISMIN","campus":"gardanne"}]');
      INSERT INTO association_calendar_events ("reachSpaces") VALUES ('[{"formation":"FSSS","campus":"gardanne"}]');
      INSERT INTO users (id, formation, cursus) VALUES
        ('u1', 'FSSS', '[{"formation":"FSSS","promo":2022},{"formation":"ICM","promo":2025}]'),
        ('u2', 'ICM', '[{"formation":"ICM","promo":2024},{"formation":"FSSS","promo":2026}]'),
        ('u3', NULL, '[]');
      INSERT INTO users_pre_wp3 VALUES ('u1', 'FSSS');
      INSERT INTO forms ("priceMatrix", "submitCondition", items) VALUES
        ('{"dimensions":[{"id":"d1","kind":"formation","buckets":[{"id":"b1","label":"Apprentis","values":["FSSS","PDIS"]}]}],"cells":{"b1":500}}',
         '{"formation":{"values":["FSSS"]}}',
         '[{"id":"q1","title":"FSSSX or FSSS?","showIf":{"formation":{"values":["FSSS"]}}}]'),
        (NULL, NULL, '[{"id":"q2","title":"untouched"}]');
      INSERT INTO association_products ("priceMatrix") VALUES
        ('{"dimensions":[{"id":"d1","kind":"formation","buckets":[{"id":"b1","values":["FSSS"]}]}],"cells":{}}');
      INSERT INTO booking_spaces (audience, items) VALUES
        ('{"formation":{"values":["ICM","FSSS"]}}', '[{"id":"i1","showIf":{"formation":{"values":["FSSS"]}}}]');
    `);
    await client.query(
      `INSERT INTO associations VALUES ($1, 'bde-bureau-des-eleves', 'BDE FSSS - Bureau des Élèves'),
        ($2, 'other-bde', 'BDE FSSS - Bureau des Élèves')`,
      [BDE_FSSS, BDE_RENAMED]
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('respells every closed column in place, ids kept', async () => {
    await client.query(MIGRATION);
    await expect(one(`SELECT formation FROM spaces WHERE id = $1`, [SPACE_SE])).resolves.toBe(
      'FISA'
    );
    await expect(one(`SELECT formation FROM spaces WHERE id = $1`, [SPACE_ICM])).resolves.toBe(
      'ICM'
    );
    const { rows: audiences } = await client.query(
      `SELECT formation FROM association_audiences ORDER BY id`
    );
    expect(audiences.map((r) => r.formation)).toEqual(['FISA', null, 'ICM']);
    const { rows: grants } = await client.query(`SELECT formation FROM read_grants ORDER BY id`);
    expect(grants.map((r) => r.formation)).toEqual(['FISA', null]);
    const { rows: subs } = await client.query(
      `SELECT formation, "selectionKey" AS k FROM agenda_subscriptions ORDER BY id`
    );
    expect(subs).toEqual([
      { formation: 'FISA', k: 'saint-etienne|FISA|-' },
      { formation: 'ICM', k: 'gardanne|ICM|-' },
    ]);
  });

  it('respells the reach arrays and the cursus element by element, order kept', async () => {
    const { rows: posts } = await client.query(`SELECT "reachSpaces" AS r FROM posts ORDER BY id`);
    expect(posts.map((p) => p.r)).toEqual([
      [
        { formation: 'ICM', campus: 'saint-etienne' },
        { formation: 'FISA', campus: 'saint-etienne' },
        { formation: 'PDIS', campus: 'gardanne' },
      ],
      null,
      [{ formation: 'ISMIN', campus: 'gardanne' }],
    ]);
    await expect(one(`SELECT "reachSpaces" FROM association_calendar_events`)).resolves.toEqual([
      { formation: 'FISA', campus: 'gardanne' },
    ]);
    const { rows: users } = await client.query(
      `SELECT id, formation, cursus FROM users ORDER BY id`
    );
    expect(users).toEqual([
      {
        id: 'u1',
        formation: 'FISA',
        cursus: [
          { formation: 'FISA', promo: 2022 },
          { formation: 'ICM', promo: 2025 },
        ],
      },
      {
        id: 'u2',
        formation: 'ICM',
        cursus: [
          { formation: 'ICM', promo: 2024 },
          { formation: 'FISA', promo: 2026 },
        ],
      },
      { id: 'u3', formation: null, cursus: [] },
    ]);
    // The backup table is a record of before, never rewritten.
    await expect(one(`SELECT formation FROM users_pre_wp3`)).resolves.toBe('FSSS');
  });

  it('respells the whole JSON string "FSSS" in saved criteria, never a substring', async () => {
    const { rows: forms } = await client.query(
      `SELECT "priceMatrix" AS m, "submitCondition" AS c, items FROM forms ORDER BY id`
    );
    expect(forms[0].m.dimensions[0].buckets[0].values).toEqual(['FISA', 'PDIS']);
    expect(forms[0].c).toEqual({ formation: { values: ['FISA'] } });
    expect(forms[0].items).toEqual([
      { id: 'q1', title: 'FSSSX or FSSS?', showIf: { formation: { values: ['FISA'] } } },
    ]);
    expect(forms[1]).toEqual({ m: null, c: null, items: [{ id: 'q2', title: 'untouched' }] });
    await expect(one(`SELECT "priceMatrix" FROM association_products`)).resolves.toMatchObject({
      dimensions: [{ buckets: [{ values: ['FISA'] }] }],
    });
    const { rows: booking } = await client.query(`SELECT audience, items FROM booking_spaces`);
    expect(booking[0]).toEqual({
      audience: { formation: { values: ['ICM', 'FISA'] } },
      items: [{ id: 'i1', showIf: { formation: { values: ['FISA'] } } }],
    });
  });

  it('renames the second BDE by slug AND 130s exact name, and no other', async () => {
    const { rows } = await client.query(`SELECT id, name FROM associations ORDER BY id`);
    expect(rows).toEqual([
      { id: BDE_FSSS, name: 'BDE FISA - Bureau des Élèves' },
      { id: BDE_RENAMED, name: 'BDE FSSS - Bureau des Élèves' },
    ]);
  });

  it('ends on the new list: FSSS is refused, FISA accepted', async () => {
    await expect(
      client.query(`INSERT INTO spaces VALUES (gen_random_uuid(), 'FSSS', 'gardanne')`)
    ).rejects.toThrow(/CHK_spaces_formation/);
    await expect(
      client.query(`INSERT INTO association_audiences (formation) VALUES ('FSSS')`)
    ).rejects.toThrow(/CHK_association_audiences_formation/);
    await expect(
      client.query(`INSERT INTO read_grants (campus, formation) VALUES ('gardanne', 'FSSS')`)
    ).rejects.toThrow(/read_grants_formation_check/);
    await client.query(`INSERT INTO read_grants (campus, formation) VALUES ('gardanne', 'FISA')`);
    await client.query(`DELETE FROM read_grants WHERE campus = 'gardanne' AND formation = 'FISA'`);
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const snapshot = async () =>
      (
        await client.query(
          `SELECT (SELECT json_agg(s ORDER BY id) FROM spaces s) AS s,
                  (SELECT json_agg(u ORDER BY id) FROM users u) AS u,
                  (SELECT json_agg(f ORDER BY id) FROM forms f) AS f,
                  (SELECT json_agg(a ORDER BY id) FROM associations a) AS a`
        )
      ).rows[0];
    const before = await snapshot();
    await client.query(MIGRATION);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back whole when a row it does not rewrite still says FSSS', async () => {
    // A spaces row only the narrowing can see (a lower-case spelling no UPDATE matches): the
    // narrowed CHECK must refuse it and leave every rewrite of the run undone.
    await client.query(`ALTER TABLE spaces DROP CONSTRAINT "CHK_spaces_formation"`);
    await client.query(`UPDATE users SET formation = 'FSSS' WHERE id = 'u1'`);
    await client.query(`INSERT INTO spaces VALUES (gen_random_uuid(), 'fsss', 'gardanne')`);
    await expect(client.query(MIGRATION)).rejects.toThrow(/CHK_spaces_formation/);
    await client.query('ROLLBACK');
    await expect(one(`SELECT formation FROM users WHERE id = 'u1'`)).resolves.toBe('FSSS');
  });
});
