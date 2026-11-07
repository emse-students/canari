/**
 * WHO GOVERNS WHICH ASSOCIATION, against a REAL PostgreSQL - migrations 071 and 072.
 *
 * `holdsBdeFlagOverSql` is the one GOVERNANCE predicate (the MANAGE_ASSO super-admin tier, MODERATE
 * over an association's content, the delete route); `holdsBdeAgendaRightOverSql` the AGENDA one
 * (validating an event, the proposal notification, the pending queue). The unit specs give their
 * answers as fixtures; this file proves the answers themselves: since WP-D2 a BDE governs exactly
 * its CHILDREN (`parentAssociationId`) and itself, whatever their audience reaches, and validates
 * the events of every association whose rules reach a space it is the BDE of.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `reel-retention.integration.spec.ts` and for its reason;
 * CI's `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
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
  ASSOCIATIONS_UNDER_BDE_AGENDA_RIGHT_SQL,
  BDE_SPACE_STANDINGS_SQL,
  ASSOCIATIONS_UNDER_BDE_FLAG_SQL,
  BDE_AGENDA_RIGHT_HOLDERS_OVER_SQL,
  HOLDS_BDE_AGENDA_RIGHT_OVER_SQL,
  HOLDS_BDE_FLAG_OVER_SQL,
  TARGETS_AN_UNGOVERNED_SPACE_SQL,
  holdsBdeAgendaRightOverSql,
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
  // An INSTITUTION reaching both BDEs' spaces: no BDE manages it (owner, 2026-11-02), but its
  // events are on the agenda of the BDEs of the spaces they target (owner, 2026-11-03).
  school: '00000000-0000-4000-8000-0000000000c7',
  schoolGa: '00000000-0000-4000-8000-0000000000c8', // an INSTITUTION reaching (ISMIN, gardanne) only
  // A child whose PARENT governs no space (a mere club): governed by nobody (reform 2.2).
  clubOrphan: '00000000-0000-4000-8000-0000000000c9', // rule (ICM, saint-etienne), parent clubSe
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
  school: [
    ['ICM', 'saint-etienne'],
    ['ISMIN', 'gardanne'],
  ],
  schoolGa: [['ISMIN', 'gardanne']],
  clubOrphan: [['ICM', 'saint-etienne']],
};

/**
 * THE GOVERNING PARENTS (WP-D2). Chosen so that the audience never decides: clubBoth reaches both
 * BDEs and depends on bdeSe alone; clubFsssSe reaches only a saint-etienne space and depends on the
 * gardanne BDE; clubAll reaches everyone and depends on nobody; clubOrphan depends on a mere club.
 * The BDEs and the institutions depend on nobody (D2).
 */
const PARENT: Partial<Record<AssoKey, AssoKey>> = {
  clubSe: 'bdeSe',
  clubGa: 'bdeGa',
  clubBoth: 'bdeSe',
  clubFsssSe: 'bdeGa',
  clubOrphan: 'clubSe',
};

/** Members: who holds which flag where. `clubVal` holds VALIDATE_EVENTS in a club - inert. */
const MEMBERS: { userId: string; asso: AssoKey; permissions: number }[] = [
  { userId: 'seVal', asso: 'bdeSe', permissions: VALIDATE_EVENTS | PROPOSE_EVENT },
  { userId: 'seManage', asso: 'bdeSe', permissions: MANAGE_ASSO },
  { userId: 'gaVal', asso: 'bdeGa', permissions: VALIDATE_EVENTS },
  { userId: 'gaManage', asso: 'bdeGa', permissions: MANAGE_ASSO },
  { userId: 'bothVal', asso: 'bdeSe', permissions: VALIDATE_EVENTS },
  { userId: 'bothVal', asso: 'bdeGa', permissions: VALIDATE_EVENTS },
  { userId: 'clubVal', asso: 'clubSe', permissions: VALIDATE_EVENTS | MANAGE_ASSO },
  { userId: 'plain', asso: 'bdeSe', permissions: PROPOSE_EVENT },
];
const USERS = [...new Set(MEMBERS.map((m) => m.userId))];

/**
 * Who may validate each association's events - the matrix the user decided (6c). An institution's
 * events included: the agenda follows the spaces an event targets (owner, 2026-11-03).
 */
const VALIDATORS: Record<AssoKey, string[]> = {
  bdeSe: ['bothVal', 'seVal'],
  bdeGa: ['bothVal', 'gaVal'],
  clubSe: ['bothVal', 'seVal'],
  clubGa: ['bothVal', 'gaVal'],
  clubBoth: ['bothVal', 'gaVal', 'seVal'],
  clubNone: [],
  clubAll: ['bothVal', 'gaVal', 'seVal'],
  clubFsssSe: [],
  school: ['bothVal', 'gaVal', 'seVal'],
  schoolGa: ['bothVal', 'gaVal'],
  clubOrphan: ['bothVal', 'seVal'],
};

/** Who GOVERNS each association at MANAGE_ASSO (WP-D2): its parent's holders, and nobody else. */
const MANAGERS: Record<AssoKey, string[]> = {
  bdeSe: ['seManage'],
  bdeGa: ['gaManage'],
  clubSe: ['seManage'],
  clubGa: ['gaManage'],
  clubBoth: ['seManage'],
  clubNone: [],
  clubAll: [],
  clubFsssSe: ['gaManage'],
  school: [],
  schoolGa: [],
  clubOrphan: [],
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
        "isBDE" boolean NOT NULL DEFAULT false, type varchar NOT NULL DEFAULT 'association',
        "parentAssociationId" uuid);
      CREATE TABLE posts (id uuid PRIMARY KEY);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions integer NOT NULL DEFAULT 0);
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "associationId" uuid NOT NULL);
    `);
    for (const [key, id] of Object.entries(A)) {
      await client.query(
        `INSERT INTO associations (id, name, "isBDE", type) VALUES ($1, $2, $3, $4)`,
        [id, key, key === 'bdeSe', key.startsWith('school') ? 'institution' : 'association']
      );
    }
    for (const [child, parent] of Object.entries(PARENT)) {
      await client.query(`UPDATE associations SET "parentAssociationId" = $2 WHERE id = $1`, [
        A[child as AssoKey],
        A[parent],
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
    'the agenda of %s: exactly the VALIDATE_EVENTS holders of the BDE(s) of the spaces it targets',
    async (asso) => {
      const holders: string[] = [];
      for (const userId of USERS) {
        const { rows } = await client.query(HOLDS_BDE_AGENDA_RIGHT_OVER_SQL, [userId, A[asso]]);
        if (rows[0].holds === true) holders.push(userId);
      }
      expect(holders.sort()).toEqual(VALIDATORS[asso]);
    }
  );

  it('the notification recipients are the same people, association by association', async () => {
    for (const asso of Object.keys(A) as AssoKey[]) {
      const { rows } = await client.query(BDE_AGENDA_RIGHT_HOLDERS_OVER_SQL, [A[asso]]);
      expect({ asso, told: rows.map((r) => r.userId as string) }).toEqual({
        asso,
        told: VALIDATORS[asso],
      });
    }
  });

  it.each(Object.keys(A) as AssoKey[])(
    'the governance of %s: exactly the MANAGE_ASSO holders of its parent, or of itself as a BDE (WP-D2)',
    async (asso) => {
      const holders: string[] = [];
      for (const userId of USERS) {
        const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [
          userId,
          A[asso],
          MANAGE_ASSO,
        ]);
        if (rows[0].holds === true) holders.push(userId);
      }
      expect(holders.sort()).toEqual(MANAGERS[asso]);
    }
  );

  it('governs by PARENT: the audience neither grants governance nor takes it away (WP-D2)', async () => {
    const reach = async (userId: string, flag: number) =>
      (await client.query(ASSOCIATIONS_UNDER_BDE_FLAG_SQL, [userId, flag])).rows
        .map((r) => NAME[r.id as string])
        .sort();
    // clubBoth reaches both BDEs' spaces and is bdeSe's alone; clubAll reaches everyone and is
    // nobody's; clubFsssSe reaches a saint-etienne space and is the gardanne BDE's.
    expect(await reach('seManage', MANAGE_ASSO)).toEqual(['bdeSe', 'clubBoth', 'clubSe']);
    expect(await reach('gaManage', MANAGE_ASSO)).toEqual(['bdeGa', 'clubFsssSe', 'clubGa']);
    // MANAGE_ASSO is not VALIDATE_EVENTS: each flag is its own question.
    expect(await reach('seManage', VALIDATE_EVENTS)).toEqual([]);
    expect(await reach('gaVal', VALIDATE_EVENTS)).toEqual(['bdeGa', 'clubFsssSe', 'clubGa']);
    expect(await reach('clubVal', VALIDATE_EVENTS)).toEqual([]);
    expect(await reach('clubVal', MANAGE_ASSO)).toEqual([]);
    expect(await reach('plain', VALIDATE_EVENTS)).toEqual([]);
    // The AGENDA reach is the same space rule plus the institutions' events.
    const agenda = async (userId: string) =>
      (await client.query(ASSOCIATIONS_UNDER_BDE_AGENDA_RIGHT_SQL, [userId])).rows
        .map((r) => NAME[r.id as string])
        .sort();
    expect(await agenda('gaVal')).toEqual([
      'bdeGa',
      'clubAll',
      'clubBoth',
      'clubGa',
      'school',
      'schoolGa',
    ]);
    // clubOrphan is governed by nobody, and its events still reach seVal's agenda: the two differ.
    expect(await agenda('seVal')).toEqual([
      'bdeSe',
      'clubAll',
      'clubBoth',
      'clubOrphan',
      'clubSe',
      'school',
    ]);
    expect(await agenda('seManage')).toEqual([]);
    expect(await agenda('clubVal')).toEqual([]);
  });

  it('never MANAGES an institution, whatever spaces its audience reaches', async () => {
    for (const userId of USERS) {
      for (const flag of [VALIDATE_EVENTS, MANAGE_ASSO]) {
        for (const school of [A.school, A.schoolGa]) {
          const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [userId, school, flag]);
          expect({ userId, flag, holds: rows[0].holds }).toEqual({ userId, flag, holds: false });
        }
      }
    }
    const reach = await client.query(ASSOCIATIONS_UNDER_BDE_FLAG_SQL, ['seManage', MANAGE_ASSO]);
    expect(reach.rows.map((r) => r.id)).not.toContain(A.school);
  });

  it('refuses any BDE an institution even when a hand-written row names a BDE as its parent (E5, G9)', async () => {
    // Migration 131's trigger refuses such a row; the predicate does not rely on it.
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE associations SET "parentAssociationId" = $2 WHERE id = $1`, [
        A.school,
        A.bdeSe,
      ]);
      const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [
        'seManage',
        A.school,
        MANAGE_ASSO,
      ]);
      expect(rows[0].holds).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('closes the shared campus: a whole-campus rule over two BDEs makes only the PARENT govern (P1)', async () => {
    // saint-etienne split between two BDEs - bdeSe (ICM) and bdeGa (FSSS) - and a club addressing
    // the whole campus, child of bdeSe. Read from reach, BOTH BDEs were its uncapped super-admins.
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation = 'FSSS'`,
        [A.bdeGa]
      );
      await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [
        A.clubSe,
      ]);
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'saint-etienne')`,
        [A.clubSe]
      );
      const holds = async (userId: string) =>
        (await client.query(HOLDS_BDE_FLAG_OVER_SQL, [userId, A.clubSe, MANAGE_ASSO])).rows[0]
          .holds as boolean;
      expect(await holds('seManage')).toBe(true);
      expect(await holds('gaManage')).toBe(false);
      // The agenda still follows the spaces: both BDEs validate its events, each for its spaces.
      const agenda = async (userId: string) =>
        (await client.query(HOLDS_BDE_AGENDA_RIGHT_OVER_SQL, [userId, A.clubSe])).rows[0]
          .holds as boolean;
      expect(await agenda('seVal')).toBe(true);
      expect(await agenda('gaVal')).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves an entity with no parent, or a parent governing no space, to the platform admin', async () => {
    for (const userId of USERS) {
      for (const asso of ['clubNone', 'clubAll', 'clubOrphan'] as AssoKey[]) {
        const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [
          userId,
          A[asso],
          MANAGE_ASSO,
        ]);
        expect({ userId, asso, holds: rows[0].holds }).toEqual({ userId, asso, holds: false });
      }
    }
    // The club officer holds MANAGE_ASSO in clubOrphan's parent - a club governing nothing.
    const { rows } = await client.query(HOLDS_BDE_FLAG_OVER_SQL, [
      'clubVal',
      A.clubOrphan,
      MANAGE_ASSO,
    ]);
    expect(rows[0].holds).toBe(false);
  });

  it('names the associations whose proposals the platform admins are told of too', async () => {
    const ungoverned: AssoKey[] = [];
    for (const asso of Object.keys(A) as AssoKey[]) {
      const { rows } = await client.query(TARGETS_AN_UNGOVERNED_SPACE_SQL, [A[asso]]);
      if (rows[0].ungoverned === true) ungoverned.push(asso);
    }
    // No rule (clubNone), a space with no BDE (FSSS x saint-etienne, and the rest of gardanne for
    // the whole-campus clubGa), or everyone (clubAll). An institution targeting only governed spaces
    // is told to its BDEs alone.
    expect(ungoverned.sort()).toEqual(['clubAll', 'clubFsssSe', 'clubGa', 'clubNone']);
  });

  it('filters a list of events by their association, as the pending queue splices it', async () => {
    const { rows } = await client.query(
      `SELECT e."associationId" FROM association_calendar_events e
        WHERE ${holdsBdeAgendaRightOverSql('$1', 'e."associationId"')} ORDER BY e.id`,
      ['seVal']
    );
    expect(rows.map((r) => NAME[r.associationId as string]).sort()).toEqual([
      'bdeSe',
      'clubAll',
      'clubBoth',
      'clubOrphan',
      'clubSe',
      'school',
    ]);
  });

  it('an INSTITUTION governing a space (WP-D1, D3) answers for its agenda and manages nothing', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation = 'FSSS'`,
        [A.school]
      );
      await client.query(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, 'schoolStaff', $2)`,
        [A.school, VALIDATE_EVENTS | MANAGE_ASSO]
      );
      const holds = async (sql: string, params: unknown[]) =>
        (await client.query(sql, params)).rows[0].holds as boolean;
      const fsssGoverned = async () =>
        (
          (await client.query(BDE_SPACE_STANDINGS_SQL, ['schoolStaff', MANAGE_ASSO])).rows as {
            formation: string;
            campus: string;
            governed: boolean;
          }[]
        ).find((r) => r.formation === 'FSSS' && r.campus === 'saint-etienne')?.governed;

      expect(await holds(HOLDS_BDE_AGENDA_RIGHT_OVER_SQL, ['schoolStaff', A.clubFsssSe])).toBe(
        true
      );
      // Even named as the club's PARENT by a hand-written row (131's trigger refuses one), an
      // institution governs nothing.
      await client.query(`UPDATE associations SET "parentAssociationId" = $2 WHERE id = $1`, [
        A.clubFsssSe,
        A.school,
      ]);
      expect(await holds(HOLDS_BDE_FLAG_OVER_SQL, ['schoolStaff', A.clubFsssSe, MANAGE_ASSO])).toBe(
        false
      );
      expect(await fsssGoverned()).toBe(false);

      // The control: the SAME parent typed as an association governs it - the exclusion is the
      // governor's type and nothing else.
      await client.query(`UPDATE associations SET type = 'association' WHERE id = $1`, [A.school]);
      expect(await holds(HOLDS_BDE_FLAG_OVER_SQL, ['schoolStaff', A.clubFsssSe, MANAGE_ASSO])).toBe(
        true
      );
      expect(await fsssGoverned()).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a parent losing its last space takes the power with it', async () => {
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = NULL WHERE campus = 'gardanne' AND formation = 'ICM'`
    );
    // bdeGa still governs ISMIN x gardanne, so its child stays governed by it.
    const still = await client.query(HOLDS_BDE_FLAG_OVER_SQL, ['gaVal', A.clubGa, VALIDATE_EVENTS]);
    expect(still.rows[0].holds).toBe(true);
    await client.query(`UPDATE spaces SET "bdeAssociationId" = NULL WHERE campus = 'gardanne'`);
    const gone = await client.query(HOLDS_BDE_FLAG_OVER_SQL, ['gaVal', A.clubGa, VALIDATE_EVENTS]);
    expect(gone.rows[0].holds).toBe(false);
  });
});
