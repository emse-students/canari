/**
 * THE DEPENDENCY AXIS AGAINST A REAL POSTGRESQL (WP-D1; reform 2.2, 2.7) - migrations 129, 130, 131.
 *
 * - 129 adds the label column and the journal;
 * - 130 applies the parents list the owner validated on 2026-11-03, all or nothing, by slug: on an
 *   estate without those associations it writes nothing and says so; with some missing, or with a
 *   row the list did not see, it RAISES and writes nothing; applied, it is idempotent;
 * - 131's guard refuses to install the triggers while one existing row breaks the rules (the 2.7
 *   count), and its triggers then refuse every hand-written UPDATE that would - each refusal a 23514
 *   whose CONSTRAINT field carries the code `dependency-rules.ts` names, and each proven by dropping
 *   the trigger and watching the same write pass. The TS twin (`dependencyRefusal`) is asked the
 *   same cases as the SQL function.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (CI's
 * `test-social-integration` sets it and fails on a skipped test):
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- dependency-triggers.integration
 *
 * Everything happens in throwaway schemas, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  DEPENDENCY_CHILD_IS_A_BDE,
  DEPENDENCY_INSTITUTION,
  DEPENDENCY_PARENT_NOT_A_BDE,
  dependencyRefusal,
  dependencyRefusalOf,
} from './dependency-rules';
import type { EntityType } from './dependency-rules';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
const M129 = migration('129_dependencies_schema.sql');
const M130 = migration('130_dependency_parents.sql');
const M131 = migration('131_dependency_triggers.sql');

/** The validated rows, read from migration 130 itself: slug, type, current parent, new parent, label. */
const LIST = [
  ...M130.matchAll(
    /ARRAY\['([^']+)', '(association|list)', (NULL|'[^']+'), '([^']+)', (NULL|'[^']+')\]/g
  ),
].map((m) => ({
  slug: m[1],
  type: m[2] as EntityType,
  current: m[3] === 'NULL' ? null : m[3].slice(1, -1),
  next: m[4],
  label: m[5] === 'NULL' ? null : m[5].slice(1, -1),
}));

const FORMATIONS = ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'];

/** The minimal shape the three migrations touch - the ORM owns the rest in real life. */
async function createShape(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE associations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug varchar UNIQUE NOT NULL, name varchar NOT NULL,
    type varchar(20) NOT NULL DEFAULT 'association', "parentAssociationId" uuid NULL)`);
  await client.query(`CREATE TABLE spaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formation varchar(16) NOT NULL,
    campus varchar(32) NOT NULL, "bdeAssociationId" uuid NULL, UNIQUE (formation, campus))`);
  for (const campus of ['saint-etienne', 'gardanne']) {
    for (const formation of FORMATIONS) {
      await client.query(`INSERT INTO spaces (formation, campus) VALUES ($1, $2)`, [
        formation,
        campus,
      ]);
    }
  }
}

/** Runs a migration file; on failure rolls its open transaction back and rethrows. */
async function run(client: Client, sql: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/** The CONSTRAINT-carried code of a refused statement (via the service's own reader), or null. */
async function refusal(
  client: Client,
  sql: string,
  params: unknown[] = []
): Promise<string | null> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    const code = dependencyRefusalOf(e);
    if (code === null) throw e;
    return code;
  }
}

maybe('the dependency axis against PostgreSQL (migrations 129-131)', () => {
  const tag = Math.random().toString(36).slice(2, 10);
  const schema = `dependency_it_${tag}`;
  const empty = `dependency_it_empty_${tag}`;
  let client: Client;
  const id = new Map<string, string>();

  const parentOf = async (slug: string) =>
    (
      await client.query<{ p: string | null }>(
        `SELECT "parentAssociationId" AS p FROM associations WHERE slug = $1`,
        [slug]
      )
    ).rows[0].p;
  const journalCount = async () =>
    Number((await client.query(`SELECT count(*) FROM dependency_journal`)).rows[0].count);

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    // An estate WITHOUT the production associations first (the dev seed's shape).
    await createShape(client, empty);
    await client.query(`INSERT INTO associations (slug, name) VALUES ('bde-fictif', 'BDE Fictif')`);
    await run(client, M129);

    await createShape(client, schema);
    const add = async (slug: string, type: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO associations (slug, name, type) VALUES ($1, $1, $2) RETURNING id`,
        [slug, type]
      );
      id.set(slug, rows[0].id);
    };
    for (const row of LIST) await add(row.slug, row.type);
    await add('bde', 'association');
    await add('bde-bureau-des-eleves', 'association');
    await add('minitel', 'association');
    await add('ecole', 'institution');
    await add('club-libre', 'association');
    // The governors as production holds them: bde 4 spaces, the FSSS BDE 1, MINITEL 1 at gardanne.
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation <> 'FSSS'`,
      [id.get('bde')]
    );
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation = 'FSSS'`,
      [id.get('bde-bureau-des-eleves')]
    );
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'gardanne' AND formation = 'ICM'`,
      [id.get('minitel')]
    );
    for (const row of LIST) {
      if (row.current === null) continue;
      await client.query(`UPDATE associations SET "parentAssociationId" = $1 WHERE slug = $2`, [
        id.get(row.current),
        row.slug,
      ]);
    }
    await run(client, M129);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${empty} CASCADE`);
    await client.end();
  });

  it('reads the 74 validated rows from migration 130, every one under bde', () => {
    expect(LIST).toHaveLength(74);
    expect(new Set(LIST.map((r) => r.next))).toEqual(new Set(['bde']));
    expect(LIST.filter((r) => r.label !== null)).toHaveLength(26);
  });

  it('130 writes nothing, and says so, on an estate without the production associations', async () => {
    await client.query(`SET search_path TO ${empty}`);
    const notices: string[] = [];
    const listen = (n: { message?: string }) => notices.push(n.message ?? '');
    client.on('notice', listen);
    await run(client, M130);
    client.off('notice', listen);
    expect(notices.some((n) => n.includes('nothing written'))).toBe(true);
    expect(await journalCount()).toBe(0);
    await client.query(`SET search_path TO ${schema}`);
  });

  it('131 REFUSES to install while a row breaks the rules (the 2.7 count), and installs nothing', async () => {
    await expect(run(client, M131)).rejects.toThrow(/break the dependency rules/);
    const { rows } = await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_%_dependency'
         AND tgrelid::regclass::text LIKE $1`,
      [`${schema}.%`]
    );
    expect(rows).toEqual([]);
  });

  it('130 RAISES and writes nothing when the list meets a row it did not see', async () => {
    // A list moved under MINITEL since the owner validated the list.
    const drifted = LIST.find((r) => r.current === 'bds')!;
    await client.query(`UPDATE associations SET "parentAssociationId" = $1 WHERE slug = $2`, [
      id.get('minitel'),
      drifted.slug,
    ]);
    await expect(run(client, M130)).rejects.toThrow(/did not see/);
    expect(await journalCount()).toBe(0);
    await client.query(`UPDATE associations SET "parentAssociationId" = $1 WHERE slug = $2`, [
      id.get('bds'),
      drifted.slug,
    ]);
  });

  it('130 RAISES, naming them, when only some slugs exist', async () => {
    await client.query(`UPDATE associations SET slug = 'renamed-away' WHERE slug = 'minitel'`);
    await expect(run(client, M130)).rejects.toThrow(/missing, nothing written: minitel/);
    await client.query(`UPDATE associations SET slug = 'minitel' WHERE slug = 'renamed-away'`);
    expect(await journalCount()).toBe(0);
  });

  it('130 applies exactly the validated list: parents, labels, the rename, MINITEL, journaled', async () => {
    await run(client, M130);
    for (const row of LIST) {
      expect([row.slug, await parentOf(row.slug)]).toEqual([row.slug, id.get('bde')]);
      const { rows } = await client.query(
        `SELECT "displayParentAssociationId" AS l FROM associations WHERE slug = $1`,
        [row.slug]
      );
      expect([row.slug, rows[0].l]).toEqual([row.slug, row.label ? id.get(row.label) : null]);
    }
    const { rows: named } = await client.query(
      `SELECT name FROM associations WHERE slug IN ('bde', 'bde-bureau-des-eleves') ORDER BY slug`
    );
    expect(named.map((r) => r.name)).toEqual(['bde', 'BDE FSSS - Bureau des Élèves']);
    const { rows: gardanne } = await client.query(
      `SELECT DISTINCT "bdeAssociationId" AS g FROM spaces WHERE campus = 'gardanne'`
    );
    expect(gardanne).toEqual([{ g: id.get('minitel') }]);
    // One journal line per CHANGED parent and per newly governed gardanne space; the label and the
    // rename are not dependencies. Nothing is written for a list already under bde.
    const changed = LIST.filter((r) => r.current !== 'bde').length;
    expect(await journalCount()).toBe(changed + 4);
    const { rows: sources } = await client.query(
      `SELECT DISTINCT source, actor FROM dependency_journal`
    );
    expect(sources).toEqual([{ source: 'migration-130', actor: null }]);
  });

  it('130 is idempotent: a second run writes no row and no journal line', async () => {
    const before = await journalCount();
    await run(client, M130);
    expect(await journalCount()).toBe(before);
  });

  it('131 then reads zero and installs its triggers', async () => {
    await run(client, M131);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM associations a
        WHERE canari_dependency_refusal(a.id, a.type, a."parentAssociationId") IS NOT NULL`
    );
    expect(rows[0].n).toBe(0);
  });

  describe('the triggers refuse every hand-written UPDATE that breaks D2', () => {
    beforeAll(() => client.query('BEGIN'));
    afterAll(() => client.query('ROLLBACK'));

    const setParent = (slug: string, parent: string | null) =>
      refusal(client, `UPDATE associations SET "parentAssociationId" = $1 WHERE slug = $2`, [
        parent === null ? null : id.get(parent),
        slug,
      ]);
    const govern = (formation: string, campus: string, slug: string) =>
      refusal(
        client,
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = $2 AND campus = $3`,
        [id.get(slug), formation, campus]
      );

    /**
     * Each case, asked of the trigger, of the TS twin, and - the break-proof - of the database once
     * the trigger is dropped, where the same write must PASS: the refusal is the trigger's.
     */
    it.each([
      ['an institution given a parent', 'ecole', 'bde', DEPENDENCY_INSTITUTION],
      ['a BDE given a parent', 'bde-bureau-des-eleves', 'bde', DEPENDENCY_CHILD_IS_A_BDE],
      ['a parent governing nothing (the BDS)', 'club-libre', 'bds', DEPENDENCY_PARENT_NOT_A_BDE],
      ['an institution as parent', 'club-libre', 'ecole', DEPENDENCY_PARENT_NOT_A_BDE],
      ['an association as its own parent', 'bde', 'bde', DEPENDENCY_CHILD_IS_A_BDE],
    ])('refuses %s', async (_label, child, parent, code) => {
      expect(await setParent(child, parent)).toBe(code);
      const facts = async (slug: string) => {
        const { rows } = await client.query(
          `SELECT type, EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = a.id) AS governs
             FROM associations a WHERE slug = $1`,
          [slug]
        );
        return rows[0] as { type: EntityType; governs: boolean };
      };
      expect(dependencyRefusal(await facts(child), await facts(parent))).toBe(code);

      await client.query('SAVEPOINT broken');
      await client.query('DROP TRIGGER trg_associations_dependency ON associations');
      expect(await setParent(child, parent)).toBeNull();
      await client.query('ROLLBACK TO SAVEPOINT broken');
    });

    it('allows a club under the BDE, clearing it, and a label naming the BDS', async () => {
      expect(await setParent('club-libre', 'bde')).toBeNull();
      expect(await setParent('club-libre', null)).toBeNull();
      expect(
        await refusal(
          client,
          `UPDATE associations SET "displayParentAssociationId" = $1 WHERE slug = 'club-libre'`,
          [id.get('bds')]
        )
      ).toBeNull();
    });

    it('refuses designating a parented association as a space governor - and only the trigger does', async () => {
      expect(await govern('ICM', 'gardanne', 'bds')).toBe(DEPENDENCY_CHILD_IS_A_BDE);
      expect(await govern('ICM', 'gardanne', 'bde-bureau-des-eleves')).toBeNull();
      await client.query('SAVEPOINT broken');
      await client.query('DROP TRIGGER trg_spaces_dependency ON spaces');
      expect(await govern('ISMIN', 'gardanne', 'bds')).toBeNull();
      await client.query('ROLLBACK TO SAVEPOINT broken');
    });

    it('lets an INSTITUTION govern a space (D3): it is never a parent, so nothing depends on it', async () => {
      expect(await govern('PDIS', 'gardanne', 'ecole')).toBeNull();
      expect(await setParent('club-libre', 'ecole')).toBe(DEPENDENCY_PARENT_NOT_A_BDE);
    });

    it('refuses turning a parent with children into a list - and only the trigger does', async () => {
      const retype = () =>
        refusal(client, `UPDATE associations SET type = 'list' WHERE slug = 'bde'`);
      expect(await retype()).toBe(DEPENDENCY_PARENT_NOT_A_BDE);
      await client.query('SAVEPOINT broken');
      await client.query('DROP TRIGGER trg_associations_dependency ON associations');
      expect(await retype()).toBeNull();
      await client.query('ROLLBACK TO SAVEPOINT broken');
    });

    it("allows removing a parent's last space while it has children (2.2: a redesignation stays possible)", async () => {
      await client.query('SAVEPOINT redesign');
      expect(
        await refusal(
          client,
          `UPDATE spaces SET "bdeAssociationId" = NULL WHERE "bdeAssociationId" = $1`,
          [id.get('bde')]
        )
      ).toBeNull();
      await client.query('ROLLBACK TO SAVEPOINT redesign');
    });
  });

  it('serialises a parent write and a governor designation: the second sees the first (the advisory lock)', async () => {
    const other = new Client({ connectionString: URL });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${schema}`);
      const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      await client.query('BEGIN');
      await client.query(
        `UPDATE associations SET "parentAssociationId" = $1 WHERE slug = 'club-libre'`,
        [id.get('bde')]
      );
      // The designation waits on the lock the first trigger holds, then reads its committed row.
      const designation = other
        .query(
          `UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = 'FSSS' AND campus = 'gardanne'`,
          [id.get('club-libre')]
        )
        .then(
          () => null,
          (e: unknown) => dependencyRefusalOf(e)
        );
      // Proven waiting, never slept on: the other backend is parked on the advisory lock.
      for (;;) {
        const { rows } = await client.query(
          `SELECT wait_event FROM pg_stat_activity WHERE pid = $1`,
          [otherPid]
        );
        if (rows[0]?.wait_event === 'advisory') break;
      }
      await client.query('COMMIT');
      expect(await designation).toBe(DEPENDENCY_CHILD_IS_A_BDE);
    } finally {
      await client.query(
        `UPDATE associations SET "parentAssociationId" = NULL WHERE slug = 'club-libre'`
      );
      await other.end();
    }
  });
});
