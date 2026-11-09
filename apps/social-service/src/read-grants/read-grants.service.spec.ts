import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { RedisService } from '../common/redis/redis.service';
import { ReadGrantsService } from './read-grants.service';

/** A transaction manager whose `query` answers by the first matching statement. */
function setup(answers: { user?: unknown[]; write?: unknown[]; left?: unknown[] }) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('FROM users')) return answers.user ?? [{ '?column?': 1 }];
      if (sql.startsWith('INSERT INTO read_grant_journal')) return [];
      if (sql.startsWith('SELECT 1 FROM read_grants')) return answers.left ?? [{ '?column?': 1 }];
      return answers.write ?? [{ id: 'row' }];
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
    query: jest.fn(),
  } as unknown as DataSource;
  const dropCache = jest.fn(async () => 3);
  const redis = {
    incr: jest.fn(async () => 1),
    deleteByPattern: dropCache,
  } as unknown as RedisService;
  return { service: new ReadGrantsService(dataSource, redis), queries, dropCache };
}

describe('ReadGrantsService.setCell', () => {
  it('grants a cell, journals it with its actor and drops the feed cache', async () => {
    const { service, queries, dropCache } = setup({});
    await expect(service.setCell('admin-1', 'u-1', 'gardanne', null, true)).resolves.toEqual({
      changed: true,
    });
    const journal = queries.find((q) => q.sql.startsWith('INSERT INTO read_grant_journal'));
    expect(journal?.params).toEqual(['u-1', 'gardanne', null, 'grant', 'admin-1']);
    expect(dropCache).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a state already held writes no journal line and keeps the cache', async () => {
    const { service, queries, dropCache } = setup({ write: [] });
    await expect(service.setCell('admin-1', 'u-1', 'gardanne', 'ICM', true)).resolves.toEqual({
      changed: false,
    });
    expect(queries.some((q) => q.sql.startsWith('INSERT INTO read_grant_journal'))).toBe(false);
    expect(dropCache).not.toHaveBeenCalled();
  });

  it('refuses to grant to an account that does not exist, and writes nothing', async () => {
    const { service, queries } = setup({ user: [] });
    await expect(service.setCell('admin-1', 'typo', 'gardanne', null, true)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(queries.some((q) => q.sql.includes('read_grants'))).toBe(false);
  });

  it('revokes without asking whether the account still exists, and journals the revocation', async () => {
    const { service, queries } = setup({});
    await service.setCell('admin-1', 'gone', 'saint-etienne', 'FSSS', false);
    expect(queries.some((q) => q.sql.includes('FROM users'))).toBe(false);
    const journal = queries.find((q) => q.sql.startsWith('INSERT INTO read_grant_journal'));
    expect(journal?.params?.[3]).toBe('revoke');
    expect(queries.some((q) => q.sql.includes('read_grant_readers'))).toBe(false);
  });

  it("turns the reader's comment switch back OFF, journalled, when their LAST cell is revoked", async () => {
    const { service, queries } = setup({ left: [] });
    await service.setCell('admin-1', 'u-1', 'gardanne', null, false);
    const lines = queries.filter((q) => q.sql.startsWith('INSERT INTO read_grant_journal'));
    expect(lines.map((q) => q.params?.[3] ?? q.sql.match(/'(cmt_\w+)'/)?.[1])).toEqual([
      'revoke',
      'cmt_hide',
    ]);
  });
});

describe('ReadGrantsService.setSeesComments (owner, 2026-11-04)', () => {
  const journalOf = (queries: { sql: string; params?: unknown[] }[]) =>
    queries.find((q) => q.sql.startsWith('INSERT INTO read_grant_journal'));

  it('turns the switch on, journals it as cmt_show with no cell, and drops the feed cache', async () => {
    const { service, queries, dropCache } = setup({});
    await expect(service.setSeesComments('admin-1', 'u-1', true)).resolves.toEqual({
      changed: true,
    });
    expect(journalOf(queries)?.params).toEqual(['u-1', 'admin-1']);
    expect(journalOf(queries)?.sql).toContain("NULL, NULL, 'cmt_show'");
    expect(dropCache).toHaveBeenCalledTimes(1);
  });

  it('turns it off as cmt_hide, without asking whether the account still exists', async () => {
    const { service, queries } = setup({});
    await service.setSeesComments('admin-1', 'gone', false);
    expect(queries.some((q) => q.sql.includes('FROM users'))).toBe(false);
    expect(journalOf(queries)?.sql).toContain("'cmt_hide'");
  });

  it('is idempotent: a state already held writes no journal line and keeps the cache', async () => {
    const { service, queries, dropCache } = setup({ write: [] });
    for (const on of [true, false]) {
      await expect(service.setSeesComments('admin-1', 'u-1', on)).resolves.toEqual({
        changed: false,
      });
    }
    expect(journalOf(queries)).toBeUndefined();
    expect(dropCache).not.toHaveBeenCalled();
  });

  it('refuses to turn it on for an account that does not exist, and writes nothing', async () => {
    const { service, queries } = setup({ user: [] });
    await expect(service.setSeesComments('admin-1', 'typo', true)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(queries.some((q) => q.sql.includes('read_grant_readers'))).toBe(false);
  });
});
