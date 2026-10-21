/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  dateChunks,
  METER_TIMEOUT_MS,
  monthDays,
  oldestReadable,
  TurnMeterUnavailableError,
  TurnUsageMeter,
} from './turn-usage-meter.service';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const DAY = 86_400;

/** The `settings` answer: the dataset's limits for this token. */
const settingsAnswer = (maxDuration = 31 * DAY, notOlderThan = 93 * DAY, enabled = true) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            { settings: { callsTurnUsageAdaptiveGroups: { enabled, maxDuration, notOlderThan } } },
          ],
        },
      },
      errors: null,
    }),
    { status: 200 }
  );

/** The usage answer: one aliased list of per-date groups per chunk (`c0`, `c1`, ...). */
const usageAnswer = (...perChunk: Record<string, unknown>[]) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            Object.fromEntries(
              perChunk.map((days, i) => [
                `c${i}`,
                Object.entries(days).map(([date, egressBytes]) => ({
                  dimensions: { date },
                  sum: { egressBytes },
                })),
              ])
            ),
          ],
        },
      },
      errors: null,
    }),
    { status: 200 }
  );

const queryOf = (call: unknown[]): string =>
  (JSON.parse(String((call[1] as RequestInit).body)) as { query: string }).query;

describe('the day arithmetic', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('lists the UTC calendar month from its first day to today', () => {
    const days = monthDays(now);
    expect(days).toHaveLength(21);
    expect(days[0]).toBe('2026-10-01');
    expect(days[20]).toBe('2026-10-21');
  });

  it('names the oldest date the dataset can still answer', () => {
    // 8 days back from 12:00 is 2026-10-13T12:00: that day started earlier, so the 14th.
    expect(oldestReadable(now, { maxDuration: DAY, notOlderThan: 8 * DAY })).toBe('2026-10-14');
    // The 32 days measured on 2026-10-21: the whole month, and more.
    expect(oldestReadable(now, { maxDuration: DAY, notOlderThan: 32 * DAY })).toBe('2026-09-20');
  });

  it('asks a range in one chunk when the dataset allows it', () => {
    expect(
      dateChunks('2026-10-01', now, { maxDuration: 31 * DAY, notOlderThan: 93 * DAY })
    ).toEqual([{ from: '2026-10-01', to: '2026-10-21' }]);
  });

  it('splits a range into whole-day chunks no wider than maxDuration, dropping no day', () => {
    expect(
      dateChunks('2026-10-01', now, { maxDuration: 7 * DAY + 5, notOlderThan: 93 * DAY })
    ).toEqual([
      { from: '2026-10-01', to: '2026-10-07' },
      { from: '2026-10-08', to: '2026-10-14' },
      { from: '2026-10-15', to: '2026-10-21' },
    ]);
  });

  it('refuses a window under one day - a date filter cannot ask less', () => {
    expect(() =>
      dateChunks('2026-10-21', now, { maxDuration: 3600, notOlderThan: 93 * DAY })
    ).toThrow(TurnMeterUnavailableError);
  });

  it('refuses a day older than the retention - a part would under-count', () => {
    expect(() =>
      dateChunks('2026-10-01', now, { maxDuration: 31 * DAY, notOlderThan: 8 * DAY })
    ).toThrow(/less than the .* back to 2026-10-01/);
  });
});

describe('TurnUsageMeter (B7: the budget is what Cloudflare metered)', () => {
  const store = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const redis = {
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    hgetall: jest.fn((k: string) => Promise.resolve({ ...hashes.get(k) })),
    hset: jest.fn((k: string, fields: Record<string, string>) => {
      hashes.set(k, { ...hashes.get(k), ...fields });
      return Promise.resolve(Object.keys(fields).length);
    }),
    hdel: jest.fn((k: string, ...fields: string[]) => {
      const h = { ...hashes.get(k) };
      for (const f of fields) delete h[f];
      hashes.set(k, h);
      return Promise.resolve(fields.length);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
  };
  let meter: TurnUsageMeter;
  let fetchSpy: jest.SpyInstance;
  let error: jest.SpyInstance;
  const now = new Date('2026-10-21T12:00:00Z');
  const DAYS_KEY = 'turn:metered:days:2026-10';

  /** Days 2026-10-<from>..<to> stored at 10 bytes each, read as far back as `coveredFrom`. */
  const storeDays = (from: number, to: number, coveredFrom = '2026-10-01') => {
    const fields: Record<string, string> = { covered_from: coveredFrom };
    for (let d = from; d <= to; d++) fields[`2026-10-${String(d).padStart(2, '0')}`] = '10';
    hashes.set(DAYS_KEY, fields);
  };

  beforeEach(() => {
    store.clear();
    hashes.clear();
    jest.clearAllMocks();
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN = 'analytics-token';
    meter = new TurnUsageMeter(redis as unknown as Redis);
    fetchSpy = jest.spyOn(global, 'fetch');
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN;
    jest.restoreAllMocks();
  });

  it('reads the limits, then the month per date account-wide, and stores what it read', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer())
      .mockResolvedValueOnce(usageAnswer({ '2026-10-03': 100, '2026-10-20': 20, '2026-10-21': 3 }));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(123);

    const [settingsCall, usageCall] = fetchSpy.mock.calls;
    expect(settingsCall[0]).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((settingsCall[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer analytics-token',
    });
    expect(queryOf(settingsCall)).toContain(
      'settings { callsTurnUsageAdaptiveGroups { enabled maxDuration notOlderThan } }'
    );
    const usage = queryOf(usageCall);
    expect(usage).toContain(`accountTag: "${ACCOUNT}"`);
    expect(usage).toContain(
      'c0: callsTurnUsageAdaptiveGroups(limit: 21, filter: { date_geq: "2026-10-01", date_leq: "2026-10-21" }, orderBy: [date_ASC]) { dimensions { date } sum { egressBytes } }'
    );
    // Account-wide: the free allowance is the account's, so no key narrows the sum.
    expect(usage).not.toContain('keyId');

    // Only the days Cloudflare RETURNED are stored - never a missing day as 0 - plus the coverage.
    expect(hashes.get(DAYS_KEY)).toEqual({
      '2026-10-03': '100',
      '2026-10-20': '20',
      '2026-10-21': '3',
      covered_from: '2026-10-01',
    });
    expect(redis.expire).toHaveBeenCalledWith(DAYS_KEY, 70 * DAY);
  });

  // A LATE INGESTION IS COUNTED: nothing is frozen while Cloudflare can still correct it.
  it('re-asks every readable day on every reading, and overwrites what it stored', async () => {
    storeDays(1, 20);
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer())
      .mockResolvedValueOnce(usageAnswer({ '2026-10-03': 150, '2026-10-21': 7 }));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(157);
    expect(queryOf(fetchSpy.mock.calls[1])).toContain(
      'filter: { date_geq: "2026-10-01", date_leq: "2026-10-21" }'
    );
    expect(hashes.get(DAYS_KEY)!['2026-10-03']).toBe('150');
    // A day stored before and with no group now is dropped, not kept at its old value.
    expect(hashes.get(DAYS_KEY)!['2026-10-04']).toBeUndefined();
  });

  // THE POINT OF STORING: a dataset keeping 8 days still meters the whole month.
  it('sums the stored days that left a short retention, and asks only the readable ones', async () => {
    storeDays(1, 13);
    delete hashes.get(DAYS_KEY)!['2026-10-05']; // read, and no group: no relay that day
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer(31 * DAY, 8 * DAY))
      .mockResolvedValueOnce(usageAnswer({ '2026-10-21': 7 }));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(12 * 10 + 7);
    expect(queryOf(fetchSpy.mock.calls[1])).toContain(
      'filter: { date_geq: "2026-10-14", date_leq: "2026-10-21" }'
    );
  });

  it('is unavailable when a day left the retention without ever being read - never a 0', async () => {
    storeDays(5, 13, '2026-10-05'); // 2026-10-01 .. 04 were never read
    fetchSpy.mockResolvedValueOnce(settingsAnswer(31 * DAY, 8 * DAY));

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(
      /2026-10-01 left the dataset's retention .* without ever being read/
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('splits the asked days into sub-queries when the window is narrower', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer(7 * DAY))
      .mockResolvedValueOnce(usageAnswer({ '2026-10-02': 100 }, {}, { '2026-10-21': 23 }));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(123);
    expect(queryOf(fetchSpy.mock.calls[1])).toContain('c2: callsTurnUsageAdaptiveGroups(limit: 7');
  });

  it('reuses a reading for a minute and the limits for an hour', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer())
      .mockResolvedValueOnce(usageAnswer({ '2026-10-21': 42 }));

    await meter.monthEgressBytes(now);
    await meter.monthEgressBytes(now);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith('turn:metered:2026-10', '42', 'EX', 60);
    expect(redis.set).toHaveBeenCalledWith('turn:metered:settings', expect.any(String), 'EX', 3600);
  });

  it('asks Cloudflare once for concurrent callers (single flight)', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer())
      .mockResolvedValueOnce(usageAnswer({ '2026-10-21': 9 }));

    const all = await Promise.all([1, 2, 3, 4].map(() => meter.monthEgressBytes(now)));

    expect(all).toEqual([9, 9, 9, 9]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds every request with a timeout, and names it when it fires', async () => {
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    });

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(
      `no answer within ${METER_TIMEOUT_MS} ms`
    );
  });

  it.each([
    ['no account id', () => delete process.env.CLOUDFLARE_ACCOUNT_ID],
    ['an account id that is not 32 hex', () => (process.env.CLOUDFLARE_ACCOUNT_ID = 'x" } }')],
    ['no token', () => delete process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN],
  ])('is unavailable, asking nothing, when configured with %s', async (_n, unset) => {
    unset();

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(TurnMeterUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a transport failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['an HTTP error', () => Promise.resolve(new Response('denied', { status: 403 }))],
    [
      'a GraphQL error',
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized' }] }), {
            status: 200,
          })
        ),
    ],
    [
      'no account visible to the token',
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), { status: 200 })
        ),
    ],
    ['a dataset not enabled', () => Promise.resolve(settingsAnswer(31 * DAY, 93 * DAY, false))],
  ])('is unavailable on %s, typed, logged once, and caches no number', async (_n, respond) => {
    fetchSpy.mockImplementation(respond);

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(TurnMeterUnavailableError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(store.has('turn:metered:2026-10')).toBe(false);
    expect(hashes.has(DAYS_KEY)).toBe(false);
  });

  it.each([
    ['a sum that is not a number', { '2026-10-21': 'lots' }, /a non-number/],
    ['a null sum (which Number() would read as 0)', { '2026-10-21': null }, /a non-number/],
    ['a group outside its range', { '2026-09-30': 1 }, /a group outside its range/],
  ])('is unavailable on %s', async (_n, days, reason) => {
    fetchSpy.mockResolvedValueOnce(settingsAnswer()).mockResolvedValueOnce(usageAnswer(days));

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(reason);
    expect(hashes.has(DAYS_KEY)).toBe(false);
  });

  it('remembers a failure for 30 s: an outage is not one more API call and error per call setup', async () => {
    fetchSpy.mockResolvedValue(new Response('denied', { status: 403 }));

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(TurnMeterUnavailableError);
    await expect(meter.monthEgressBytes(now)).rejects.toThrow(/failed less than 30s ago: HTTP 403/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'turn:metered:unavailable',
      expect.stringContaining('HTTP 403'),
      'EX',
      30
    );
  });
});
