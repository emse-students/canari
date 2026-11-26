import { Logger } from '@nestjs/common';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import {
  ALUMNI_MERGE_SITES,
  ALUMNI_MERGE_SITE_PATH,
  AlumniMergeSiteJobsService,
} from './alumni-merge-site-jobs.service';
import { ALUMNI_MERGE_TOKEN_TYPE } from '../auth/handoff/handoff-token';

jest.mock('axios');

/**
 * THE SIBLING-SITE JOBS OF A COMPLETED ALUMNI MERGE (D52-D54): one durable job per site, a signed call
 * each, a typed 409 blocks without retry, anything else retries with backoff, and the daily report
 * accuses a job pending over a day. The table is scripted; the SQL's shape is the claim the account
 * erasure's integration spec runs against a real PostgreSQL.
 */
describe('AlumniMergeSiteJobsService', () => {
  const axios = jest.requireMock('axios') as { post: jest.Mock };
  const saved = { key: process.env.HANDOFF_SIGNING_KEY, url: process.env.FRONTEND_URL };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let log: Record<'log' | 'warn' | 'error', jest.SpyInstance>;

  beforeEach(() => {
    process.env.HANDOFF_SIGNING_KEY = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    process.env.FRONTEND_URL = 'https://canari.example';
    log = {
      log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    };
    axios.post = jest.fn();
  });
  afterEach(() => {
    process.env.HANDOFF_SIGNING_KEY = saved.key;
    process.env.FRONTEND_URL = saved.url;
    jest.restoreAllMocks();
  });

  const JOB = {
    id: 'job-1',
    mergeId: 'merge-1',
    site: 'migallery',
    duplicateSubject: 'sub-dup',
    targetSubject: 'sub-target',
    attempts: 0,
  };

  /** A service over a scripted table: `claims` are what each claim returns, in order. */
  function make(claims: unknown[][] = [], report: unknown[] = []) {
    const queries: Array<[string, unknown[] | undefined]> = [];
    let claim = 0;
    const dataSource = {
      query: jest.fn(async (sql: string, params?: unknown[]): Promise<unknown> => {
        queries.push([sql, params]);
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claims[claim++] ?? [], 0];
        if (sql.includes('AS pending')) return [{ pending: 1, blocked: 0 }];
        if (sql.includes('make_interval(hours')) return report;
        return [[], 1];
      }),
    };
    const service = new AlumniMergeSiteJobsService(dataSource as unknown as DataSource);
    return { service, queries };
  }

  it('owes one job per MiConnect site of the contract: Sky, MiGallery, Le Cercle - not Portail-etu', async () => {
    expect([...ALUMNI_MERGE_SITES].sort()).toEqual(['le-cercle', 'migallery', 'sky']);
    const { service } = make();
    const manager = { query: jest.fn(async () => []) };
    await service.writeJobs(
      manager as unknown as EntityManager,
      'merge-1',
      'sub-dup',
      'sub-target'
    );
    expect(manager.query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of manager.query.mock.calls as unknown as [string, unknown[]][]) {
      expect(sql).toContain('ON CONFLICT ("mergeId", site) DO NOTHING');
      expect(params).toEqual(['merge-1', expect.any(String), 'sub-dup', 'sub-target']);
    }
  });

  it("calls the site with a 60 s canari-merge+jwt naming both subjects, and completes on the site's outcome", async () => {
    const { service, queries } = make([[JOB]]);
    axios.post.mockResolvedValue({ status: 200, data: { outcome: 'transferred' } });
    await service.drain();

    const [url, , config] = axios.post.mock.calls[0] as [
      string,
      unknown,
      { headers: { authorization: string } },
    ];
    expect(url).toBe(`https://gallery.mitv.fr${ALUMNI_MERGE_SITE_PATH}`);
    const token = config.headers.authorization.replace(/^Bearer /, '');
    const [header, claims, signature] = token.split('.');
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(h).toEqual(expect.objectContaining({ alg: 'ES256', typ: ALUMNI_MERGE_TOKEN_TYPE }));
    expect(c).toEqual(
      expect.objectContaining({
        aud: 'migallery',
        dup: 'sub-dup',
        target: 'sub-target',
        jti: 'job-1',
      })
    );
    expect(c.exp - c.iat).toBe(60);
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
    const done = queries.find(([sql]) => sql.includes('"completedAt" = now()'));
    expect(done?.[1]).toEqual(['job-1', 'transferred']);
  });

  it('a typed 409 BLOCKS the job: no retry, an error line', async () => {
    const { service, queries } = make([[JOB]]);
    axios.post.mockRejectedValue({
      response: { status: 409, data: { code: 'ALUMNI_MERGE_BOTH_ACCOUNTS_HOLD' } },
    });
    await service.drain();
    const blocked = queries.find(([sql]) => sql.includes('"blockedAt" = now()'));
    expect(blocked?.[1]).toEqual(['job-1', 'HTTP 409 ALUMNI_MERGE_BOTH_ACCOUNTS_HOLD']);
    expect(queries.some(([sql]) => sql.includes('attempts = $2'))).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('BLOCKED merge=merge-1'));
  });

  it('a transport failure retries with backoff', async () => {
    const { service, queries } = make([[JOB]]);
    axios.post.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );
    await service.drain();
    const retried = queries.find(([sql]) => sql.includes('attempts = $2'));
    expect(retried?.[1]).toEqual(['job-1', 1, 'ECONNREFUSED', 30]);
    expect(queries.some(([sql]) => sql.includes('"blockedAt" = now()'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('retried in 30s'));
  });

  it('a 2xx naming no outcome is retried, never completed', async () => {
    const { service, queries } = make([[JOB]]);
    axios.post.mockResolvedValue({ status: 200, data: {} });
    await service.drain();
    expect(queries.some(([sql]) => sql.includes('"completedAt" = now()'))).toBe(false);
    expect(queries.find(([sql]) => sql.includes('attempts = $2'))?.[1]?.[2]).toContain(
      'SITE_ANSWER_MALFORMED'
    );
  });

  it('a 404 (the site has not shipped its endpoint) is retried, not blocked', async () => {
    const { service, queries } = make([[JOB]]);
    axios.post.mockRejectedValue({ response: { status: 404, data: {} } });
    await service.drain();
    expect(queries.some(([sql]) => sql.includes('"blockedAt" = now()'))).toBe(false);
    expect(queries.find(([sql]) => sql.includes('attempts = $2'))?.[1]?.[2]).toBe('HTTP 404');
  });

  it('the daily report names a job pending over 24 h, by merge and site, at error', async () => {
    const { service } = make(
      [],
      [
        {
          mergeId: 'merge-1',
          site: 'sky',
          attempts: 7,
          lastError: 'HTTP 503',
          createdAt: new Date('2026-11-20T00:00:00Z'),
          blockedAt: null,
        },
      ]
    );
    expect(await service.report()).toEqual({ pending: 1, blocked: 0, overdue: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('OVERDUE merge=merge-1 site=sky')
    );
  });
});
