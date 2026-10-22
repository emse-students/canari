/**
 * THE LIVE GUARD AGAINST A REAL `platform_config`, built by core-service's own migration 015: the
 * SQL the guard runs, the column it names and the values the CHECK lets an admin write - none of
 * which a scripted `query` mock can vouch for.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `lives.integration.spec.ts`: CI's
 * `test-social-integration` job sets it and runs every `*.integration.spec.ts`, failing on a skip;
 * without it (a plain local run) the file reports as skipped. Everything happens in a throwaway schema.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/postgres bun run test -- lives-mode.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LiveEnabledGuard } from './live-enabled.guard';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** core-service owns the column; its migration is read from where it ships, never copied. */
const MIGRATION_015 = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'core-service',
    'src',
    'migrations',
    '015_platform_config_lives_mode.sql'
  ),
  'utf8'
);

maybe('LiveEnabledGuard against platform_config (migration 015)', () => {
  const schema = `lives_mode_social_it_${Date.now()}`;
  let ds: DataSource;
  const savedSwitch = process.env.LIVE_ENABLED;

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
    await ds.query(`CREATE TABLE platform_config (id int PRIMARY KEY)`);
    await ds.query(`INSERT INTO platform_config (id) VALUES (1)`);
    await ds.query(MIGRATION_015);
    process.env.LIVE_ENABLED = 'true';
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (savedSwitch === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = savedSwitch;
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  const status = async (guard: LiveEnabledGuard) => {
    try {
      await guard.canActivate();
      return HttpStatus.OK;
    } catch (e) {
      return (e as { getStatus: () => number }).getStatus();
    }
  };

  it('is closed by the migration default, opens on `on`, and closes again on the next request', async () => {
    const guard = new LiveEnabledGuard(ds);
    expect(await status(guard)).toBe(HttpStatus.NOT_FOUND);
    await ds.query(`UPDATE platform_config SET lives_mode = 'on' WHERE id = 1`);
    expect(await status(guard)).toBe(HttpStatus.OK);
    await ds.query(`UPDATE platform_config SET lives_mode = 'off' WHERE id = 1`);
    expect(await status(guard)).toBe(HttpStatus.NOT_FOUND);
  });

  it('is closed when the row is missing', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await ds.query(`DELETE FROM platform_config`);
    expect(await status(new LiveEnabledGuard(ds))).toBe(HttpStatus.NOT_FOUND);
    expect(error).toHaveBeenCalled();
  });
});
