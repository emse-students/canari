/**
 * WHO GOVERNS WHICH ASSOCIATION (WP6c step 2), against a REAL PostgreSQL - migrations 071 and 072.
 *
 * `holdsBdeFlagOverSql` is the one predicate behind validating an event, the proposal notification,
 * the pending queue's `canValidate` and the MANAGE_ASSO super-admin tier. The unit specs give its
 * answer as a fixture; this file proves the answer itself: a BDE governs exactly the associations
 * whose rules reach a space it is the BDE of.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `reader-spaces.integration.spec.ts`: CI provides no
 * database here, and the whole file reports as skipped rather than passing. Run it against any
 * throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- bde.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  ASSOCIATIONS_UNDER_BDE_FLAG_SQL,
  BDE_FLAG_HOLDERS_OVER_SQL,
  HOLDS_BDE_FLAG_OVER_SQL,
  holdsBdeFlagOverSql,
  isBdeAssociationSql,
} from './bde';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const { VALIDATE_EVENTS, MANAGE_ASSO, PROPOSE_EVENT } = AssociationPermissionFlag;

/** Readable ids: a failure names an association, not a uuid. */
const A = {
  bdeSe: '00000000-0000-4000-8000-0000000000b1', // BDE of ICM x saint-etienne
  bdeGa: '00000000-0000-4000-8000-0000000000b2', // BDE of ISMIN x gardanne AND ICM x gardanne
  clubSe: '00000000-0000-4000-8000-0000000000c1', // rule (ICM, saint-etienne)
  clubGa: '00000000-0000-4000-8000-0000000000c2', // rule (NULL, gardanne): the whole campus
  clubBoth: '00000000-0000-4000-8000-0000000000c3', // two rules: one per BDE
  clubNone: '00000000-0000-4000-8000-0000000000c4', // no rule: reaches no space
  clubAll: '00000000-0000-4000-8000-0000000000c5', // rule (NULL, NULL): everyone
  clubFsssSe: '00000000-0000-4000-8000-0000000000c6', // (FSSS, saint-etienne): a space with no BDE
} as const;
type AssoKey = keyof typeof A;
const NAME = Object.fromEntries(Object.entries(A).map(([k, v]) => [v, k])) as Record<
  string,
  AssoKey
>;

const RULES: Record<AssoKey, [string | null, string | null][]> = {
  bdeSe: [['ICM', 'saint-etienne']],
  bdeGa: [
    ['ISMIN', 'gardanne'],
    ['ICM', 'gardanne'],
  ],
  clubSe: [['ICM', 'saint-etienne']],
  clubGa: [[null, 'gardanne']],
  clubBoth: [
    ['ICM', 'saint-etienne'],
    ['ISMIN', 'gardanne'],
  ],
  clubNone: [],
  clubAll: [[null, null]],
  clubFsssSe: [['FSSS', 'saint-etienne']],
};

/** Members: who holds which flag where. `clubVal` holds VALIDATE_EVENTS in a club - inert. */
const MEMBERS: { userId: string; asso: AssoKey; permissions: number }[] = [
  { userId: 'seVal', asso: 'bdeSe', permissions: VALIDATE_EVENTS | PROPOSE_EVENT },
  { userId: 'seManage', asso: 'bdeSe', permissions: MANAGE_ASSO },
  { userId: 'gaVal', asso: 'bdeGa', permissions: VALIDATE_EVENTS },
  { userId: 'bothVal', asso: 'bdeSe', permissions: VALIDATE_EVENTS },
  { userId: 'bothVal', asso: 'bdeGa', permissions: VALIDATE_EVENTS },
  { userId: 'clubVal', asso: 'clubSe', permissions: VALIDATE_EVENTS | MANAGE_ASSO },
  { userId: 'plain', asso: 'bdeSe', permissions: PROPOSE_EVENT },
];
const USERS = [...new Set(MEMBERS.map((m) => m.userId))];

/** Who may validate each association's events - the matrix the user decided (6c). */
const VALIDATORS: Record<AssoKey, string[]> = {
  bdeSe: ['bothVal', 'seVal'],
  bdeGa: ['bothVal', 'gaVal'],
  clubSe: ['bothVal', 'seVal'],
  clubGa: ['bothVal', 'gaVal'],
  clubBoth: ['bothVal', 'gaVal', 'seVal'],
  clubNone: [],
  clubAll: ['bothVal', 'gaVal', 'seVal'],
  clubFsssSe: [],
};

maybe('BDE governance against PostgreSQL (migrations 071 and 072 included)', () => {
  const schema = `bde_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // The shape 071 found in production: `isBDE` still a column, one association carrying it.
    await client.query(`
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions integer NOT NULL DEFAULT 0);
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "associationId" uuid NOT NULL);
    `);
    for (const [key, id] of Object.entries(A)) {
      await client.query(`INSERT INTO associations (id, name, "isBDE") VALUES ($1, $2, $3)`, [
        id,
        key,
        key === 'bdeSe',
      ]);
    }
    await client.query(migration('071_spaces.sql'));
    await client.query(migration('072_drop_is_bde.sql'));
    // The grid as an admin would set it.
    await client.query(`DELETE FROM association_audiences`);
    for (const [key, rules] of Object.entries(RULES)) {
      for (const [formation, campus] of rules) {
        await client.query(
          `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
          [A[key as AssoKey], formation, campus]
        );
      }
    }
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'gardanne' AND formation IN ('ISMIN', 'ICM')`,
      [A.bdeGa]
    );
    for (const m of MEMBERS) {
      await client.query(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, $2, $3)`,
        [A[m.asso], m.userId, m.permissions]
      );
    }
    for (const id of Object.values(A)) {
      await client.query(`INSERT INTO association_calendar_events ("associationId") VALUES ($1)`, [
        id,
      ]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('072 dropped isBDE, and 071 made the one flagged association the BDE of ICM x saint-etienne', async () => {
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'associations' AND column_name = 'isBDE'`,
      [schema]
    );
    expect(col.rowCount).toBe(0);
    const { rows } = await client.query(
      `SELECT a.id FROM associations a WHERE ${isBdeAssociationSql('a')} ORDER BY a.id`
    );
    expect(rows.map((r) => NAME[r.id as string])).toEqual(['bdeSe', 'bdeGa']);
  });

  it.each(Object.keys(A) as AssoKey[])(
    'VALIDATE_EVENTS over %s: exactly the BDE(s) of the spaces it reaches',
    async (asso) => {
      const holders: string[] = [];
      for (const userId of USERS) {
        const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [
          userId,
          A[asso],
          VALIDATE_EVENTS,
        ]);
        if (rows[0].holds === true) holders.push(userId);
      }
      expect(holders.sort()).toEqual(VALIDATORS[asso]);
    }
  );

  it('the notification recipients are the same people, association by association', async () => {
    for (const asso of Object.keys(A) as AssoKey[]) {
      const { rows } = await client.query(BDE_FLAG_HOLDERS_OVER_SQL, [A[asso], VALIDATE_EVENTS]);
      expect({ asso, told: rows.map((r) => r.userId as string) }).toEqual({
        asso,
        told: VALIDATORS[asso],
      });
    }
  });

  it('scopes MANAGE_ASSO the same way, and a flag held in a mere club grants nothing', async () => {
    const reach = async (userId: string, flag: number) =>
      (await client.query(ASSOCIATIONS_UNDER_BDE_FLAG_SQL, [userId, flag])).rows
        .map((r) => NAME[r.id as string])
        .sort();
    expect(await reach('seManage', MANAGE_ASSO)).toEqual([
      'bdeSe',
      'clubAll',
      'clubBoth',
      'clubSe',
    ]);
    // MANAGE_ASSO is not VALIDATE_EVENTS: each flag is its own reach.
    expect(await reach('seManage', VALIDATE_EVENTS)).toEqual([]);
    expect(await reach('gaVal', VALIDATE_EVENTS)).toEqual([
      'bdeGa',
      'clubAll',
      'clubBoth',
      'clubGa',
    ]);
    expect(await reach('clubVal', VALIDATE_EVENTS)).toEqual([]);
    expect(await reach('clubVal', MANAGE_ASSO)).toEqual([]);
    expect(await reach('plain', VALIDATE_EVENTS)).toEqual([]);
  });

  it('filters a list of events by their association, as the pending queue splices it', async () => {
    const { rows } = await client.query(
      `SELECT e."associationId" FROM association_calendar_events e
        WHERE ${holdsBdeFlagOverSql('$1', 'e."associationId"', '$2')} ORDER BY e.id`,
      ['seVal', VALIDATE_EVENTS]
    );
    expect(rows.map((r) => NAME[r.associationId as string]).sort()).toEqual([
      'bdeSe',
      'clubAll',
      'clubBoth',
      'clubSe',
    ]);
  });

  it('a space losing its BDE takes the power with it', async () => {
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = NULL WHERE campus = 'gardanne' AND formation = 'ICM'`
    );
    // bdeGa still governs ISMIN x gardanne, so the whole-campus club stays governed by it.
    const still = await client.query(HOLDS_BDE_FLAG_OVER_SQL, ['gaVal', A.clubGa, VALIDATE_EVENTS]);
    expect(still.rows[0].holds).toBe(true);
    await client.query(`UPDATE spaces SET "bdeAssociationId" = NULL WHERE campus = 'gardanne'`);
    const gone = await client.query(HOLDS_BDE_FLAG_OVER_SQL, ['gaVal', A.clubGa, VALIDATE_EVENTS]);
    expect(gone.rows[0].holds).toBe(false);
  });
});
