/**
 * Migration 124 against a REAL PostgreSQL: every row holding MANAGE_MEMBERS receives EDIT_PROFILE,
 * no other row is touched, no other bit moves, and a second run changes nothing.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (CI's
 * `test-social-integration` sets it and fails on a skipped test):
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- edit-profile-migration.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { AssociationPermissionFlag as F } from './entities/association-member.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '124_edit_profile.sql'), 'utf8');

/** Each row's bitmask before the migration, and what it must read after. */
const ROWS: { id: string; before: number; after: number }[] = [
  // The old admin preset (3871): MANAGE_MEMBERS among others - gains bit 12 alone.
  { id: '00000000-0000-4000-8000-000000000001', before: 3871, after: 3871 | F.EDIT_PROFILE },
  // MANAGE_MEMBERS alone.
  {
    id: '00000000-0000-4000-8000-000000000002',
    before: F.MANAGE_MEMBERS,
    after: F.MANAGE_MEMBERS | F.EDIT_PROFILE,
  },
  // Already holding both: unchanged.
  {
    id: '00000000-0000-4000-8000-000000000003',
    before: F.MANAGE_MEMBERS | F.EDIT_PROFILE,
    after: F.MANAGE_MEMBERS | F.EDIT_PROFILE,
  },
  // Every flag but MANAGE_MEMBERS: unchanged, even without bit 12.
  {
    id: '00000000-0000-4000-8000-000000000004',
    before: 8191 & ~F.MANAGE_MEMBERS & ~F.EDIT_PROFILE,
    after: 8191 & ~F.MANAGE_MEMBERS & ~F.EDIT_PROFILE,
  },
  // A plain member: unchanged.
  { id: '00000000-0000-4000-8000-000000000005', before: 0, after: 0 },
  // A bit above every flag the enum knows survives: the migration ORs one bit, it never rebuilds.
  {
    id: '00000000-0000-4000-8000-000000000006',
    before: (1 << 20) | F.MANAGE_MEMBERS,
    after: (1 << 20) | F.MANAGE_MEMBERS | F.EDIT_PROFILE,
  },
];

maybe('migration 124 against PostgreSQL (EDIT_PROFILE backfill)', () => {
  const schema = `edit_profile_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The minimal shape the migration touches - the ORM owns the rest in real life.
    await client.query(`CREATE TABLE association_members (
      id uuid PRIMARY KEY, "permissions" integer NOT NULL DEFAULT 0)`);
    for (const row of ROWS) {
      await client.query(`INSERT INTO association_members (id, "permissions") VALUES ($1, $2)`, [
        row.id,
        row.before,
      ]);
    }
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  /** The read-only count the migration's header gives, run as written there. */
  async function pending(): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM association_members
       WHERE ("permissions" & 4) <> 0 AND ("permissions" & 4096) = 0`
    );
    return Number(rows[0].count);
  }

  it('counts, before it runs, exactly the rows it will rewrite', async () => {
    await expect(pending()).resolves.toBe(3);
  });

  it('ORs EDIT_PROFILE into every MANAGE_MEMBERS row and moves no other bit', async () => {
    await client.query(MIGRATION);
    const { rows } = await client.query<{ id: string; permissions: number }>(
      `SELECT id, "permissions" FROM association_members ORDER BY id`
    );
    expect(rows).toEqual(ROWS.map((r) => ({ id: r.id, permissions: r.after })));
    await expect(pending()).resolves.toBe(0);
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const { rows: before } = await client.query(
      `SELECT id, "permissions" FROM association_members ORDER BY id`
    );
    await client.query(MIGRATION);
    const { rows: after } = await client.query(
      `SELECT id, "permissions" FROM association_members ORDER BY id`
    );
    expect(after).toEqual(before);
  });
});
