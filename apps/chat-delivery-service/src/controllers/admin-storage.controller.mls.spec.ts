/// <reference types="jest" />

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { AdminStorageController } from './admin-storage.controller';

/**
 * The MLS half of `/admin/storage`.
 *
 * What is worth pinning is not the SQL - a query is proved by running it against the database, and
 * these were - but the two properties the panel's honesty rests on:
 *
 *   1. **Each measurement fails on its own.** Four measurements share one endpoint, and one of them
 *      throwing must never blank the other three. That is the same isolation the four totals above
 *      already have, and it is the difference between a panel that degrades and a panel that goes
 *      dark for a reason nobody can see.
 *   2. **The queue's weekly buckets are placed by index.** Postgres hands them back grouped and in
 *      no particular order, with gaps for quiet weeks; putting a row in the wrong bucket would draw
 *      a slope that is not there, which is precisely what the bars exist to show.
 */

type QueryHandler = (sql: string, params?: unknown[]) => Promise<unknown>;

function makeController(query: QueryHandler, redis?: Partial<Record<string, unknown>>) {
  const dataSource = { query: jest.fn(query) } as unknown as DataSource;
  const redisClient = {
    info: jest.fn().mockResolvedValue('# Keyspace\r\ndb0:keys=1234,expires=7,avg_ttl=0\r\n'),
    scan: jest.fn().mockResolvedValue(['0', ['session:a', 'session:b', 'rate:c']]),
    ...redis,
  } as unknown as Redis;
  return new AdminStorageController(dataSource, redisClient);
}

/** Routes a query to a canned answer by what it selects, since all five share one `query` method. */
function router(overrides: Partial<Record<string, unknown>> = {}): QueryHandler {
  return async (sql: string) => {
    if (sql.includes('pg_database_size')) return [{ bytes: '42' }];
    if (sql.includes('pg_total_relation_size(c.oid) AS bytes')) {
      return (
        overrides.tables ?? [
          { table: 'queued_message', bytes: '76472320', rows: '820' },
          { table: 'key_package', bytes: '491520', rows: '260' },
        ]
      );
    }
    if (sql.includes('COUNT(DISTINCT "deviceId") AS devices')) {
      return overrides.totals ?? [{ rows: '820', devices: '42', oldest: '86400000' }];
    }
    if (sql.includes('MAX(c) AS deepest')) return overrides.deepest ?? [{ deepest: '189' }];
    if (sql.includes('604800'))
      return (
        overrides.weeks ?? [
          { week: '0', c: '5' },
          { week: '3', c: '9' },
        ]
      );
    if (sql.includes('dm_device_group_memberships m')) {
      return overrides.ghosts ?? [{ devices: '52', ghosts: '0', orphans: '0' }];
    }
    throw new Error(`unrouted query: ${sql.slice(0, 40)}`);
  };
}

describe('the MLS half of the storage panel', () => {
  it('reports the queue as four numbers, because a total cannot show a single deep queue', async () => {
    const controller = makeController(router());

    const usage = await controller.getStorageUsage('true');

    expect(usage.mls?.queue).toEqual({
      rows: 820,
      devices: 42,
      deepest: 189,
      oldestMs: 86400000,
      // Placed BY INDEX: Postgres returned weeks 0 and 3 only, and weeks 1 and 2 are zeros rather
      // than the next values in the list.
      rowsByWeek: [5, 0, 0, 9],
    });
  });

  it('shows the ghost count even when it is zero', async () => {
    const controller = makeController(router());

    const usage = await controller.getStorageUsage('true');

    // A counter that only appears when it is non-zero is a counter nobody believes the first time
    // it does appear. WP-GHOST-1 was found by hand; this is the same question asked continuously.
    expect(usage.mls?.ghosts).toEqual({
      devicesWithMemberships: 52,
      devicesWithoutKeyPackage: 0,
      orphanMemberships: 0,
    });
  });

  it('keeps the other three measurements when one of them throws', async () => {
    const base = router();
    const controller = makeController(async (sql, params) => {
      if (sql.includes('MAX(c) AS deepest')) throw new Error('statement timeout');
      return base(sql, params);
    });

    const usage = await controller.getStorageUsage('true');

    expect(usage.mls?.queue).toBeNull();
    expect(usage.mls?.tables).toHaveLength(2);
    expect(usage.mls?.ghosts).not.toBeNull();
    expect(usage.mls?.redisKeyspace).not.toBeNull();
  });

  it('says how many keys it SAMPLED, rather than implying a census', async () => {
    const controller = makeController(router());

    const usage = await controller.getStorageUsage('true');

    expect(usage.mls?.redisKeyspace).toEqual({
      keys: 1234,
      sampled: 3,
      byPrefix: [
        { prefix: 'session', keys: 2 },
        { prefix: 'rate', keys: 1 },
      ],
    });
  });

  it('refuses a caller who is not a global admin, before measuring anything', async () => {
    const query = jest.fn();
    const controller = makeController(query as unknown as QueryHandler);

    await expect(controller.getStorageUsage(undefined)).rejects.toThrow(
      'Operation restricted to global admins'
    );
    expect(query).not.toHaveBeenCalled();
  });
});
