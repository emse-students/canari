/// <reference types="jest" />

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { TurnUsageMeter } from './turn-usage-meter.service';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

/** A GraphQL answer carrying one aggregate group, as Cloudflare returns it with no dimensions. */
const answer = (egressBytes: unknown, groups = 1) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              callsTurnUsageAdaptiveGroups: Array.from({ length: groups }, () => ({
                sum: { egressBytes },
              })),
            },
          ],
        },
      },
      errors: null,
    }),
    { status: 200 }
  );

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
  const now = new Date('2026-10-21T12:00:00Z');

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN = 'analytics-token';
    meter = new TurnUsageMeter(redis as unknown as Redis);
    fetchSpy = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN;
    jest.restoreAllMocks();
  });

  it('reads the month s egress, account-wide, from the first of the month to today', async () => {
    fetchSpy.mockResolvedValue(answer(123_456_789));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(123_456_789);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer analytics-token');
    const { query } = JSON.parse(String(init.body)) as { query: string };
    expect(query).toContain('callsTurnUsageAdaptiveGroups');
    expect(query).toContain(`accountTag: "${ACCOUNT}"`);
    expect(query).toContain('date_geq: "2026-10-01"');
    expect(query).toContain('date_leq: "2026-10-21"');
    expect(query).toContain('egressBytes');
    // Account-wide: the free allowance is the account's, so no key narrows the sum.
    expect(query).not.toContain('keyId');
  });

  it('reuses one reading for a minute, so a member hammering ice-servers cannot spend the quota', async () => {
    fetchSpy.mockResolvedValue(answer(42));

    await meter.monthEgressBytes(now);
    await meter.monthEgressBytes(now);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('turn:metered:2026-10', '42', 'EX', 60);
  });

  it('reads a month with no TURN traffic (no group at all) as zero', async () => {
    fetchSpy.mockResolvedValue(answer(0, 0));

    await expect(meter.monthEgressBytes(now)).resolves.toBe(0);
  });

  it.each([
    ['no account id', () => delete process.env.CLOUDFLARE_ACCOUNT_ID],
    ['an account id that is not 32 hex', () => (process.env.CLOUDFLARE_ACCOUNT_ID = 'x" } }')],
    ['no token', () => delete process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN],
  ])('refuses with a 503 and asks nothing when configured with %s', async (_n, unset) => {
    unset();

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(ServiceUnavailableException);
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
    ['a sum that is not a number', () => Promise.resolve(answer('lots'))],
  ])('refuses with a 503 on %s, and caches nothing', async (_n, respond) => {
    fetchSpy.mockImplementation(respond);

    await expect(meter.monthEgressBytes(now)).rejects.toThrow(ServiceUnavailableException);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
