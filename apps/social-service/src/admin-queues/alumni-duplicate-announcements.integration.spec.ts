/**
 * THE ALUMNI DUPLICATES' LEDGER, against a REAL PostgreSQL (migration 188): a duplicate is told ONCE,
 * whatever the caller does. The unit spec proves the call sequence with a fake; this proves what only
 * the database can - two flushes running AT THE SAME TIME tell a duplicate once (the claim is one
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so exactly one of two racing statements wins each
 * row), a grown set tells only what is new, and the ledger is swept of a duplicate whose flag is gone.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`; everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { takeLogged } from '../common/testing/integration-log-guard.it-fixture';
import { AdminQueuesService } from './admin-queues.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const A = '0b9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f10';
const B = '1c9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f11';
const C = '2d9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f12';

maybe('the Alumni duplicates ledger (PostgreSQL)', () => {
  const schema = `alumni_ledger_it_${process.pid}`;
  let ds: DataSource;
  let createNotifications: jest.Mock;
  let service: AdminQueuesService;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      extra: { options: `-c search_path=${schema}` },
    });
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await admin.destroy();
    await ds.initialize();
    await ds.query(
      `CREATE TABLE users (id varchar PRIMARY KEY, admin boolean NOT NULL DEFAULT false)`
    );
    await ds.query(`INSERT INTO users (id, admin) VALUES ('adm', true)`);
    await ds.query(`CREATE TABLE alumni_duplicate_flags ("duplicateUuid" uuid PRIMARY KEY)`);
    await ds.query(
      readFileSync(
        join(__dirname, '..', 'migrations', '188_alumni_duplicate_announcements.sql'),
        'utf8'
      )
    );
  }, 60_000);

  beforeEach(async () => {
    await ds.query(`DELETE FROM alumni_duplicate_announcements`);
    await ds.query(`DELETE FROM alumni_duplicate_flags`);
    for (const u of [A, B, C]) {
      await ds.query(`INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)`, [u]);
    }
    createNotifications = jest.fn(async (d: { recipientIds: string[] }) => d.recipientIds.length);
    service = new AdminQueuesService(
      { manager: ds.manager } as never,
      {} as never,
      { createNotifications } as never,
      { changed: jest.fn(async () => undefined) } as never
    );
  });

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  const told = (): string[] =>
    createNotifications.mock.calls.flatMap(
      (c) => (c[0] as { meta: { duplicateUuids: string[] } }).meta.duplicateUuids
    );

  it('two flushes of the SAME set at once tell each duplicate exactly once', async () => {
    const results = await Promise.all([
      service.announceAlumniDuplicates([A, B]),
      service.announceAlumniDuplicates([A, B]),
    ]);
    expect(told().sort()).toEqual([A, B]);
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(2);
  });

  it('overlapping sets at once tell the union once: {A,B} and {B,C}', async () => {
    await Promise.all([
      service.announceAlumniDuplicates([A, B]),
      service.announceAlumniDuplicates([B, C]),
    ]);
    expect(told().sort()).toEqual([A, B, C]);
  });

  it('{A} lost then {A,B} tells only B', async () => {
    await service.announceAlumniDuplicates([A]);
    await service.announceAlumniDuplicates([A, B]);
    expect(told()).toEqual([A, B]);
  });

  it('a failed notice releases its claim, so the retry tells', async () => {
    createNotifications.mockRejectedValueOnce(new Error('db down'));
    await expect(service.announceAlumniDuplicates([A, B])).rejects.toThrow('db down');
    expect(await ds.query(`SELECT 1 FROM alumni_duplicate_announcements`)).toHaveLength(0);
    takeLogged('error', /FAILED, their claim is released/);
    // The failed call's own arguments are not a notice that landed.
    createNotifications.mockClear();
    await service.announceAlumniDuplicates([A, B]);
    expect(told().sort()).toEqual([A, B]);
  });

  it('the next announce sweeps the rows whose flag is gone, and a re-flagged duplicate is told anew', async () => {
    await service.announceAlumniDuplicates([A, B]);
    // A's merge completed: its flag is dropped (`DROP_DUPLICATE_FLAG_SQL`).
    await ds.query(`DELETE FROM alumni_duplicate_flags WHERE "duplicateUuid" = $1`, [A]);
    await service.announceAlumniDuplicates([C]);
    const left = (await ds.query(
      `SELECT "duplicateUuid"::text AS u FROM alumni_duplicate_announcements ORDER BY 1`
    )) as { u: string }[];
    expect(left.map((r) => r.u)).toEqual([B, C]);
    // A is flagged again later (a new life): told again.
    await ds.query(`INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)`, [A]);
    await service.announceAlumniDuplicates([A]);
    expect(told().filter((u) => u === A)).toHaveLength(2);
  });
});
