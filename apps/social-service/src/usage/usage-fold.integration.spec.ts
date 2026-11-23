/// <reference types="jest" />

/**
 * The fold's upsert and the dashboard's read against a REAL PostgreSQL, through migration 182 itself:
 * `unnest ... WITH ORDINALITY`, the larger-value rule and the `to_char` of a date are properties of
 * the database, which no fake can judge (docs/wiki/usage-dashboard.md, "The fold").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * database:
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- usage-fold.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { writeFigures } from './usage-fold';
import { readUsage } from './usage-read';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('usage figures against PostgreSQL (migration 182)', () => {
  const schema = `usage_it_${Math.random().toString(36).slice(2, 10)}`;
  let db: Client;
  const ds = {
    query: (sql: string, params?: unknown[]) => db.query(sql, params).then((r) => r.rows),
  };
  const noHours = {
    pfcountEach: async (groups: readonly (readonly string[])[]) => groups.map(() => 0),
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path = ${schema}`);
    await db.query(readFileSync(join(__dirname, '../migrations/182_usage_figures.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });

  it('keeps the larger value, never lowers one, and the read names the day it was stored under', async () => {
    const day = (value: number) => ({
      period: 'day' as const,
      start: '2026-11-16',
      metric: 'people',
      dimension: 'all',
      value,
    });
    await writeFigures(ds, [day(3), { ...day(7), metric: 'messages' }]);
    await writeFigures(ds, [day(5)]);
    await writeFigures(ds, [day(4)]);
    // The migration is applied a second time by hand: harmless.
    await db.query(readFileSync(join(__dirname, '../migrations/182_usage_figures.sql'), 'utf8'));

    const view = await readUsage(ds, noHours, new Date('2026-11-23T10:00:00Z'));
    expect(view.days).toEqual([
      {
        start: '2026-11-16',
        people: { all: 5, categories: {}, versions: {} },
        activity: { messages: 7, posts: 0, reels: 0, lives: 0, calls: 0, forms: 0 },
      },
    ]);
  });

  it('refuses a period nobody decided and a negative figure', async () => {
    await expect(
      db.query(
        `INSERT INTO usage_figures (period, start, metric, dimension, value) VALUES ('hour', '2026-11-16', 'people', 'all', 1)`
      )
    ).rejects.toThrow(/usage_figures_period/);
    await expect(
      db.query(
        `INSERT INTO usage_figures (period, start, metric, dimension, value) VALUES ('day', '2026-11-16', 'posts', 'all', -1)`
      )
    ).rejects.toThrow(/usage_figures_value/);
  });
});
