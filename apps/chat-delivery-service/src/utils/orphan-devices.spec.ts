/// <reference types="jest" />

import { ORPHAN_DEVICES_SQL, reportOrphanDevices } from './orphan-devices';
import { ORPHAN_DEVICE_WARN_COUNT, RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * THE DAILY ORPHAN-DEVICE REPORT'S LINE, with the database stubbed: one read, no write, the two
 * cutoffs it is asked with, and the level - plain at or below the threshold, WARN above it. What the
 * statement COUNTS is judged against a real PostgreSQL in `orphan-devices.integration.spec.ts`.
 */
describe('reportOrphanDevices', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const logger = () => ({ log: jest.fn(), warn: jest.fn() });
  const database = (devices: number) => ({
    // `never`: the stub stands in for TypeORM's generic `query<T>`.
    query: jest.fn(
      async (): Promise<never> =>
        [{ devices, rows: devices * 10, insideGcWindow: devices }] as never
    ),
  });

  it('reads once, with the ban cutoff and the GC cutoff, and writes nothing', async () => {
    const db = database(1);
    await reportOrphanDevices(db, logger(), NOW);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, Date[]];
    expect(sql).toBe(ORPHAN_DEVICES_SQL);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(params[1].getTime()).toBe(NOW - RETENTION_WINDOW_MS);
  });

  it('prints the count plainly at the threshold', async () => {
    const l = logger();
    const count = await reportOrphanDevices(database(ORPHAN_DEVICE_WARN_COUNT), l, NOW);
    expect(count.devices).toBe(ORPHAN_DEVICE_WARN_COUNT);
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.log).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^\\[ORPHAN_DEVICES\\] devices=${ORPHAN_DEVICE_WARN_COUNT} `)
      )
    );
  });

  it('ACCUSES above the threshold', async () => {
    const l = logger();
    await reportOrphanDevices(database(ORPHAN_DEVICE_WARN_COUNT + 1), l, NOW);
    expect(l.log).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/MORE than the smallest population/));
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
