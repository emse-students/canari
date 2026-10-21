/**
 * MIGRATION 015 AGAINST A REAL POSTGRESQL: the lives kill switch lands CLOSED on a row that already
 * exists (production's and dev's), refuses a value no service understands, and replays as a no-op.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like `account-erasure.integration.spec.ts`: CI provides no
 * database here, so the file reports as skipped rather than passing. It needs no core schema - it
 * builds a `platform_config` in the shape migration 014 left it, in a throwaway schema.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- lives-mode-migration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { LIVES_MODES } from './entities/platform-config.entity';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '015_platform_config_lives_mode.sql'),
  'utf8'
);

maybe('migration 015 (platform_config.lives_mode) against PostgreSQL', () => {
  const schema = `lives_mode_it_${Date.now()}`;
  let ds: DataSource;

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // The row as an estate holds it before 015: calls OPEN, so the test can see that 015 touches
    // nothing but its own column.
    await ds.query(
      `CREATE TABLE platform_config (id int PRIMARY KEY, calls_mode varchar(16) NOT NULL DEFAULT 'off')`
    );
    await ds.query(`INSERT INTO platform_config (id, calls_mode) VALUES (1, 'audio')`);
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  it('closes lives on the row that already existed, and leaves calls as they were', async () => {
    const [row] = await ds.query(`SELECT lives_mode, calls_mode FROM platform_config WHERE id = 1`);
    expect(row).toEqual({ lives_mode: 'off', calls_mode: 'audio' });
  });

  it('accepts exactly the values the entity declares', async () => {
    for (const mode of LIVES_MODES) {
      await ds.query(`UPDATE platform_config SET lives_mode = $1 WHERE id = 1`, [mode]);
      const [row] = await ds.query(`SELECT lives_mode FROM platform_config WHERE id = 1`);
      expect(row.lives_mode).toBe(mode);
    }
    await ds.query(`UPDATE platform_config SET lives_mode = 'off' WHERE id = 1`);
  });

  it.each(['ON', 'true', 'audio', ''])('refuses %p by its CHECK constraint', async (mode) => {
    await expect(
      ds.query(`UPDATE platform_config SET lives_mode = $1 WHERE id = 1`, [mode])
    ).rejects.toThrow(/CHK_platform_config_lives_mode/);
  });
});
