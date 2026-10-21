/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  monthDateChunks,
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

/** The usage answer: one aliased group list per chunk (`c0`, `c1`, ...). */
const usageAnswer = (...perChunk: unknown[]) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            Object.fromEntries(
              perChunk.map((egress, i) => [
                `c${i}`,
                egress === null ? [] : [{ sum: { egressBytes: egress } }],
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

describe('monthDateChunks (the window, clamped to the dataset limits)', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('asks the whole month in one range when the dataset allows a month', () => {
    expect(monthDateChunks(now, { maxDuration: 31 * DAY, notOlderThan: 93 * DAY })).toEqual([
      { from: '2026-10-01', to: '2026-10-21' },
    ]);
  });

  it('splits the month into whole-day ranges no wider than maxDuration, dropping no day', () => {
    expect(monthDateChunks(now, { maxDuration: 7 * DAY + 5, notOlderThan: 93 * DAY })).toEqual([
      { from: '2026-10-01', to: '2026-10-07' },
      { from: '2026-10-08', to: '2026-10-14' },
      { from: '2026-10-15', to: '2026-10-21' },
    ]);
  });

  it('reads the first of the month alone on the first of the month', () => {
    expect(
      monthDateChunks(new Date('2026-11-01T00:10:00Z'), { maxDuration: DAY, notOlderThan: DAY })
    ).toEqual([{ from: '2026-11-01', to: '2026-11-01' }]);
  });

  it('refuses a window under one day - a date filter cannot ask less', () => {
    expect(() => monthDateChunks(now, { maxDuration: 3600, notOlderThan: 93 * DAY })).toThrow(
      TurnMeterUnavailableError
    );
  });

  it('refuses a retention that does not reach the first of the month - a part would under-count', () => {
    expect(() => monthDateChunks(now, { maxDuration: 31 * DAY, notOlderThan: 7 * DAY })).toThrow(
      /less than the/
    );
  });
});

describe('TurnUsageMeter (B7: the budget is what Cloudflare metered)', () => {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
  };
  let meter: TurnUsageMeter;
  let fetchSpy: jest.SpyInstance;
  let error: jest.SpyInstance;
  const now = new Date('2026-10-21T12:00:00Z');

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN = 'analytics-token';
    meter = new TurnUsageMeter(redis as unknown as Redis);
    fetchSpy = jest.spyOn(global, 'fetch');
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN;
    jest.restoreAllMocks();
  });

  it('reads the limits, then the month s egress account-wide with the date filter', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer())
      .mockResolvedValueOnce(usageAnswer(123_456_789));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(123_456_789);

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
      'c0: callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: "2026-10-01", date_leq: "2026-10-21" })'
    );
    expect(usage).toContain('egressBytes');
    // Account-wide: the free allowance is the account's, so no key narrows the sum.
    expect(usage).not.toContain('keyId');
  });

  it('sums the sub-queries when the dataset window is narrower than the month', async () => {
    fetchSpy
      .mockResolvedValueOnce(settingsAnswer(7 * DAY))
      .mockResolvedValueOnce(usageAnswer(100, null, 23));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(123);
    expect(queryOf(fetchSpy.mock.calls[1])).toContain('c2: callsTurnUsageAdaptiveGroups');
  });

  it('reuses a reading for a minute and the limits for an hour', async () => {
    fetchSpy.mockResolvedValueOnce(settingsAnswer()).mockResolvedValueOnce(usageAnswer(42));

    await meter.monthEgressBytes(now);
    await meter.monthEgressBytes(now);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith('turn:metered:2026-10', '42', 'EX', 60);
    expect(redis.set).toHaveBeenCalledWith('turn:metered:settings', expect.any(String), 'EX', 3600);
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
  });

  it('is unavailable on a sum that is not a number', async () => {
    fetchSpy.mockResolvedValueOnce(settingsAnswer()).mockResolvedValueOnce(usageAnswer('lots'));

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(/a non-number/);
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
