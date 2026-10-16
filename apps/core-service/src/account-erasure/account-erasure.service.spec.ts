import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AccountErasureService } from './account-erasure.service';
import { CORE_ERASURE_STATEMENTS, ERASURE_TARGETS } from './erasure-policy';

jest.mock('axios');

/**
 * THE ACCOUNT ERASURE IS A QUEUE, NOT A CALL. What used to be three `.catch(warn)` calls followed by
 * an unconditional row delete is now one transaction that deactivates the account and RECORDS the
 * erasure, then a worker that drives each record to completion. These pin the request and the
 * worker's decisions against a scripted database; `account-erasure.integration.spec.ts` runs the
 * same SQL against a real PostgreSQL.
 */
describe('AccountErasureService', () => {
  const axios = jest.requireMock('axios') as { delete: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    axios.delete = jest.fn();
  });
  afterEach(() => jest.restoreAllMocks());

  function make(claims: unknown[][] = []) {
    const queries: Array<[string, unknown[] | undefined]> = [];
    const txQueries: Array<[string, unknown[] | undefined]> = [];
    const manager = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push([sql, params]);
        return [[], 1];
      }),
    };
    let claim = 0;
    const dataSource = {
      transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
      query: jest.fn(async (sql: string, params?: unknown[]): Promise<unknown> => {
        queries.push([sql, params]);
        if (sql.includes('RETURNING id')) return [claims[claim++] ?? [], 0];
        if (sql.startsWith('SELECT 1')) return [];
        return [[], 1];
      }),
    };
    const service = new AccountErasureService(dataSource as unknown as DataSource);
    return { service, dataSource, manager, queries, txQueries };
  }

  it('deactivates the account in ONE transaction: core data, one job per service, the user row', async () => {
    const { service, dataSource, txQueries } = make();
    await service.requestErasure('subject-1');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    const sqls = txQueries.map(([sql]) => sql);
    for (const s of CORE_ERASURE_STATEMENTS) expect(sqls).toContain(s.sql);
    const jobs = txQueries.filter(([sql]) => sql.includes('INSERT INTO account_erasure_jobs'));
    expect(jobs.map(([, p]) => p?.[1])).toEqual(ERASURE_TARGETS.map((t) => t.service));
    // The user row goes LAST, inside the same transaction: nothing nominative stays in `users`.
    expect(sqls[sqls.length - 1]).toBe('DELETE FROM users WHERE id = $1');
    // No downstream call is made inside the transaction - only the worker calls out.
    await service.drain();
  });

  it('binds exactly the parameters each core statement names', async () => {
    const { service, txQueries } = make();
    await service.requestErasure('subject-1');
    for (const s of CORE_ERASURE_STATEMENTS) {
      const call = txQueries.find(([sql]) => sql === s.sql)!;
      expect(call[1]).toHaveLength(s.replacement === undefined ? 1 : 2);
    }
  });

  it('says an erasure is pending exactly while a job row is', async () => {
    const { service, dataSource } = make();
    dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    expect(await service.isErasurePending('s')).toBe(true);
    dataSource.query.mockResolvedValueOnce([]);
    expect(await service.isErasurePending('s')).toBe(false);
  });

  const job = (over: Record<string, unknown> = {}) => ({
    id: 'job-1',
    subjectId: 'subject-1',
    service: 'social',
    attempts: 0,
    lastAttemptAt: new Date('2026-10-16T13:00:00Z'),
    credentialsExpireAt: new Date('2026-10-16T12:00:00Z'),
    ...over,
  });

  it('completes a job whose call started after the tokens expired, and journals only a digest', async () => {
    const { service, queries } = make([[job()]]);
    axios.delete.mockResolvedValue({ data: { ok: true } });

    await service.drain();

    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/users/subject-1'),
      expect.objectContaining({ headers: { 'x-internal-secret': expect.any(String) } })
    );
    const done = queries.find(([sql]) => sql.includes('"completedAt" = now()'))!;
    expect(done[1]![1]).toMatch(/^sha256:/);
  });

  it('schedules ONE final pass when the first success came while a token could still act', async () => {
    const expiry = new Date('2026-10-16T14:00:00Z');
    const { service, queries } = make([[job({ credentialsExpireAt: expiry })]]);
    axios.delete.mockResolvedValue({ data: { ok: true } });

    await service.drain();

    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(false);
    const next = queries.find(([sql]) => sql.includes('"nextAttemptAt" = $2'))!;
    expect(next[1]).toEqual(['job-1', expiry]);
  });

  it('records a failure with its backoff and keeps the job pending', async () => {
    const { service, queries } = make([[job({ attempts: 2 })]]);
    axios.delete.mockRejectedValue({ response: { status: 503 } });

    await service.drain();

    const failed = queries.find(([sql]) => sql.includes('SET attempts = $2'))!;
    expect(failed[1]).toEqual(['job-1', 3, 'HTTP 503', 120]);
    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(false);
  });

  it('accuses every job pending for more than a day, at error level', async () => {
    const { service, dataSource } = make();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dataSource.query
      .mockResolvedValueOnce([{ pending: 2, completed24h: 5 }])
      .mockResolvedValueOnce([
        {
          service: 'media',
          subjectId: 'subject-9',
          requestedAt: new Date('2026-10-14T00:00:00Z'),
          attempts: 17,
          lastError: 'HTTP 503',
        },
      ]);

    expect(await service.report()).toEqual({ pending: 2, overdue: 1, completed24h: 5 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OVERDUE service=media'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lastError=HTTP 503'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('daily report: pending=2 overdue=1')
    );
  });
});
