import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AccountErasureService } from './account-erasure.service';
import { CORE_ERASURE_STATEMENTS, ERASURE_TARGETS, describeFailure } from './erasure-policy';

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

  /** `state` scripts what a read of the job table answers: pending jobs, and how many are blocked. */
  function make(claims: unknown[][] = [], state = { pending: 0, blocked: 0 }) {
    const queries: Array<[string, unknown[] | undefined]> = [];
    const txQueries: Array<[string, unknown[] | undefined]> = [];
    const answer = (sql: string): unknown =>
      sql.includes('AS pending,') && sql.includes('AS blocked') && !sql.includes('completed24h')
        ? [state]
        : [[], 1];
    const manager = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push([sql, params]);
        return answer(sql);
      }),
    };
    let claim = 0;
    const dataSource = {
      manager,
      transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
      query: jest.fn(async (sql: string, params?: unknown[]): Promise<unknown> => {
        queries.push([sql, params]);
        if (sql.includes('RETURNING id')) return [claims[claim++] ?? [], 0];
        return answer(sql);
      }),
    };
    const service = new AccountErasureService(dataSource as unknown as DataSource);
    return { service, dataSource, manager, queries, txQueries };
  }

  it('deactivates the account in ONE transaction, under the subject lock: core data, one job per part, the user row', async () => {
    const { service, dataSource, txQueries } = make();
    await service.requestErasure('subject-1');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    const sqls = txQueries.map(([sql]) => sql);
    expect(sqls[0]).toContain('pg_advisory_xact_lock');
    for (const s of CORE_ERASURE_STATEMENTS) expect(sqls).toContain(s.sql);
    const jobs = txQueries.filter(([sql]) => sql.includes('INSERT INTO account_erasure_jobs'));
    expect(jobs.map(([, p]) => p?.[1])).toEqual(ERASURE_TARGETS.map((t) => t.service));
    // core's own part is a job too: a token valid for another hour can still write in core.
    expect(jobs.map(([, p]) => p?.[1])).toContain('core');
    // The user row goes inside the same transaction: nothing nominative stays in `users`.
    expect(sqls).toContain('DELETE FROM users WHERE id = $1');
  });

  it('binds exactly the parameters each core statement names', async () => {
    const { service, txQueries } = make();
    await service.requestErasure('subject-1');
    for (const s of CORE_ERASURE_STATEMENTS) {
      const call = txQueries.find(([sql]) => sql === s.sql)!;
      expect(call[1]).toHaveLength(s.replacement === undefined ? 1 : 2);
    }
  });

  it('reads none, pending, or blocked (a permanent failure) from the pending jobs', async () => {
    expect(await make([], { pending: 0, blocked: 0 }).service.erasureState('s')).toBe('none');
    expect(await make([], { pending: 4, blocked: 0 }).service.erasureState('s')).toBe('pending');
    expect(await make([], { pending: 4, blocked: 1 }).service.erasureState('s')).toBe('blocked');
  });

  it('a sign-in that raced a deletion is seen under the lock, and what it wrote is erased again', async () => {
    const { service, txQueries } = make([], { pending: 4, blocked: 0 });

    expect(await service.confirmAfterSignIn('subject-1')).toBe('pending');

    const sqls = txQueries.map(([sql]) => sql);
    expect(sqls[0]).toContain('pg_advisory_xact_lock');
    expect(sqls).toContain('DELETE FROM auth_sessions WHERE "userId" = $1');
    expect(sqls).toContain('DELETE FROM users WHERE id = $1');
  });

  it('a sign-in with no erasure pending writes nothing', async () => {
    const { service, txQueries } = make();
    expect(await service.confirmAfterSignIn('subject-1')).toBe('none');
    expect(txQueries.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
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
    expect(done[0]).toContain('AND "completedAt" IS NULL');
    expect(done[1]![1]).toMatch(/^sha256:/);
  });

  it("runs core's own part in-process, again at its final pass, without calling out", async () => {
    const { service, queries, txQueries } = make([[job({ service: 'core' })]]);

    await service.drain();

    expect(axios.delete).not.toHaveBeenCalled();
    const sqls = txQueries.map(([sql]) => sql);
    for (const s of CORE_ERASURE_STATEMENTS) expect(sqls).toContain(s.sql);
    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(true);
  });

  it('schedules ONE final pass when the first success came while a token could still act', async () => {
    const expiry = new Date('2026-10-16T14:00:00Z');
    const { service, queries } = make([[job({ credentialsExpireAt: expiry })]]);
    axios.delete.mockResolvedValue({ data: { ok: true } });

    await service.drain();

    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(false);
    const next = queries.find(([sql]) => sql.includes('"nextAttemptAt" = $2'))!;
    expect(next[0]).toContain('AND "completedAt" IS NULL');
    expect(next[1]).toEqual(['job-1', expiry]);
  });

  it('records a transient failure with its backoff, at warn, and keeps the job pending', async () => {
    const { service, queries } = make([[job({ attempts: 2 })]]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    axios.delete.mockRejectedValue({ response: { status: 503 } });

    await service.drain();

    const failed = queries.find(([sql]) => sql.includes('SET attempts = $2'))!;
    expect(failed[0]).toContain('AND "completedAt" IS NULL');
    expect(failed[1]).toEqual(['job-1', 3, 'HTTP 503', 'transient', 120]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kind=transient'));
    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(false);
  });

  it('accuses a permanent failure at once, with the code the service gave', async () => {
    const { service, queries } = make([[job()]]);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    axios.delete.mockRejectedValue({
      response: { status: 409, data: { code: 'ERASURE_WORKSPACE_REPAIR_FAILED' } },
    });

    await service.drain();

    const failed = queries.find(([sql]) => sql.includes('SET attempts = $2'))!;
    expect(failed[1]).toEqual([
      'job-1',
      1,
      'HTTP 409 ERASURE_WORKSPACE_REPAIR_FAILED',
      'permanent',
      30,
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('a human must look'));
  });

  it('records a job naming an unknown service as a permanent failure, not a silent re-claim', async () => {
    const { service, queries } = make([[job({ service: 'gone-service' })]]);

    await service.drain();

    expect(axios.delete).not.toHaveBeenCalled();
    const failed = queries.find(([sql]) => sql.includes('SET attempts = $2'))!;
    expect(failed[1]).toEqual(['job-1', 1, 'UNKNOWN_SERVICE', 'permanent', 30]);
  });

  it('classes the SAME database error of the core pass, repeated, as permanent - and a first one as transient', async () => {
    const failure = describeFailure(new Error('syntax error'));
    const first = make([[job({ service: 'core', attempts: 0, lastError: null })]]);
    first.dataSource.transaction.mockRejectedValueOnce(new Error('syntax error'));
    await first.service.drain();
    expect(first.queries.find(([sql]) => sql.includes('SET attempts = $2'))![1]![3]).toBe(
      'transient'
    );

    const fifth = make([[job({ service: 'core', attempts: 4, lastError: failure })]]);
    fifth.dataSource.transaction.mockRejectedValueOnce(new Error('syntax error'));
    await fifth.service.drain();
    expect(fifth.queries.find(([sql]) => sql.includes('SET attempts = $2'))![1]![3]).toBe(
      'permanent'
    );
  });

  it('accuses every job pending for more than a day, and every blocked one, at error level', async () => {
    const { service, dataSource } = make();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dataSource.query
      .mockResolvedValueOnce([[], 0]) // the journal purge
      .mockResolvedValueOnce([{ pending: 2, blocked: 1, completed24h: 5, closed24h: 0 }])
      .mockResolvedValueOnce([
        {
          service: 'media',
          subjectId: 'subject-9',
          requestedAt: new Date('2026-10-14T00:00:00Z'),
          attempts: 17,
          lastError: 'HTTP 503',
          lastFailureKind: 'transient',
        },
      ]);

    expect(await service.report()).toEqual({
      pending: 2,
      blocked: 1,
      overdue: 1,
      completed24h: 5,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OVERDUE service=media'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lastError=HTTP 503'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('daily report: pending=2 blocked=1 overdue=1')
    );
  });
});
