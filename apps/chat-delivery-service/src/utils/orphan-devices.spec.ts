/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ORPHAN_DEVICES_SQL,
  ORPHAN_DEVICE_LIST_SQL,
  ORPHAN_DEVICE_RECHECK_SQL,
  ORPHAN_LIFE_WINDOW_MS,
  reportOrphanDevices,
} from './orphan-devices';
import { RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * THE DAILY ORPHAN-DEVICE REPORT'S LINE, with the database stubbed: one read, no write, the three
 * cutoffs it is asked with, and one plain line whatever the count. What the statements SELECT is
 * judged against a real PostgreSQL in `orphan-devices.integration.spec.ts`.
 */
describe('reportOrphanDevices', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const logger = () => ({ log: jest.fn() });
  const database = (devices: number) => ({
    // `never`: the stub stands in for TypeORM's generic `query<T>`.
    query: jest.fn(
      async (): Promise<never> =>
        [{ devices, rows: devices * 10, insideGcWindow: devices }] as never
    ),
  });

  it('reads once, with the ban, life and GC cutoffs, and writes nothing', async () => {
    const db = database(1);
    await reportOrphanDevices(db, logger(), NOW);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, Date[]];
    expect(sql).toBe(ORPHAN_DEVICES_SQL);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(params).toHaveLength(3);
    expect(params[1].getTime()).toBe(NOW - ORPHAN_LIFE_WINDOW_MS);
    expect(params[2].getTime()).toBe(NOW - RETENTION_WINDOW_MS);
  });

  it('prints one plain line, however large the count - there is no threshold yet', async () => {
    const l = logger();
    const count = await reportOrphanDevices(database(500), l, NOW);
    expect(count.devices).toBe(500);
    expect(l.log).toHaveBeenCalledTimes(1);
    expect(l.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[ORPHAN_DEVICES\] devices=500 rows=5000 insideGcWindow=500 /)
    );
  });

  it('an empty answer reads as zero', async () => {
    const l = logger();
    const db = { query: jest.fn(async (): Promise<never> => [] as never) };
    expect(await reportOrphanDevices(db, l, NOW)).toEqual({
      devices: 0,
      rows: 0,
      insideGcWindow: 0,
    });
    expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/devices=0 rows=0/));
  });
});

/**
 * ONE DEFINITION. The count, the hand procedure's allowlist and its per-device re-check share one
 * predicate, and the procedure on the wiki NAMES those statements instead of carrying a copy of the
 * predicate - a copy is the second definition that drifts.
 */
describe('the orphan predicate has one definition', () => {
  const predicate = (sql: string) => {
    const start = sql.indexOf('), orphan AS (');
    return sql.slice(start, sql.indexOf('\n)', start));
  };

  it('the count, the allowlist and the re-check carry the same predicate', () => {
    expect(predicate(ORPHAN_DEVICE_LIST_SQL)).toBe(predicate(ORPHAN_DEVICES_SQL));
    expect(predicate(ORPHAN_DEVICE_RECHECK_SQL)).toBe(predicate(ORPHAN_DEVICES_SQL));
    expect(predicate(ORPHAN_DEVICES_SQL)).toMatch(/mls_commit_log/);
  });

  it('the wiki procedure names the statements and holds no copy of the predicate', () => {
    const page = readFileSync(
      join(
        __dirname,
        '../../../../docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md'
      ),
      'utf8'
    );
    const procedure = page.slice(page.indexOf('### The procedure, re-runnable'));
    expect(procedure).toMatch(/ORPHAN_DEVICE_LIST_SQL/);
    expect(procedure).toMatch(/ORPHAN_DEVICE_RECHECK_SQL/);
    expect(procedure).not.toMatch(/FROM queued_message/);
  });
});
