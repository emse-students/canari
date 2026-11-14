/**
 * MIGRATION 025 AGAINST A REAL POSTGRESQL: the retention durations land on a row that already exists
 * (production's and dev's) at the values the code applied before the setting, accept exactly the
 * bounds `RETENTION_SETTINGS` declares, and replay as a no-op.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like `lives-mode-migration.integration.spec.ts`.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- retention-migration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { RETENTION_SETTINGS } from './retention';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '025_platform_config_retention.sql'),
  'utf8'
);

maybe('migration 025 (platform_config.retention_*) against PostgreSQL', () => {
  const schema = `retention_it_${Date.now()}`;
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
    await ds.query(
      `CREATE TABLE platform_config (id int PRIMARY KEY, calls_mode varchar(16) NOT NULL DEFAULT 'off')`
    );
    await ds.query(`INSERT INTO platform_config (id, calls_mode) VALUES (1, 'audio')`);
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  it("gives the existing row today's values, and leaves calls as they were", async () => {
    const [row] = await ds.query(`SELECT * FROM platform_config WHERE id = 1`);
    expect(row.calls_mode).toBe('audio');
    for (const setting of RETENTION_SETTINGS) {
      expect(row[setting.column]).toBe(setting.defaultDays);
    }
  });

  it.each(RETENTION_SETTINGS.map((s) => [s.column, s.minDays, s.maxDays] as const))(
    '%s accepts %d to %d and refuses beyond, by its CHECK',
    async (column, min, max) => {
      for (const ok of [min, max]) {
        await ds.query(`UPDATE platform_config SET ${column} = $1 WHERE id = 1`, [ok]);
      }
      for (const bad of [min - 1, max + 1]) {
        await expect(
          ds.query(`UPDATE platform_config SET ${column} = $1 WHERE id = 1`, [bad])
        ).rejects.toThrow(new RegExp(`CHK_platform_config_${column}`));
      }
    }
  );
});
