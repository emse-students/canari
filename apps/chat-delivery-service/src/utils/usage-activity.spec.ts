/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countUsageActivity,
  parisDay,
  USAGE_DAY_KEY_TTL_SECS,
  usageActivityKey,
} from './usage-activity';

const contract = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../libs/contracts/usage-dashboard.json'), 'utf8')
) as {
  keyPrefix: string;
  activityMetrics: string[];
  dayKeyTtlSecs: number;
  parisTime: { instant: string; day: string }[];
};

/** A Redis whose MULTI records what it was asked and answers `exec` with `answer`. */
function fakeRedis(answer: () => Promise<[Error | null, unknown][] | null>) {
  const calls: unknown[][] = [];
  const chain = {
    hincrby: (...a: unknown[]) => (calls.push(['hincrby', ...a]), chain),
    expire: (...a: unknown[]) => (calls.push(['expire', ...a]), chain),
    exec: answer,
  };
  return { redis: { multi: () => chain } as never, calls };
}

const logger = () => ({ debug: jest.fn(), warn: jest.fn() });

describe('usage activity (docs/wiki/usage-dashboard.md)', () => {
  it('names the Paris day of every instant of the contract, both changes of the hour included', () => {
    for (const c of contract.parisTime)
      expect([c.instant, parisDay(new Date(c.instant))]).toEqual([c.instant, c.day]);
  });

  it('writes under the contract prefix, with the contract lifetime and metric names', () => {
    expect(usageActivityKey('2026-11-23').startsWith(contract.keyPrefix)).toBe(true);
    expect(USAGE_DAY_KEY_TTL_SECS).toBe(contract.dayKeyTtlSecs);
    expect(contract.activityMetrics).toEqual(expect.arrayContaining(['messages', 'calls']));
  });

  it('adds one to the day of the injected instant and gives the hash its expiry in the same transaction', async () => {
    const { redis, calls } = fakeRedis(async () => [
      [null, 1],
      [null, 1],
    ]);
    const log = logger();
    // 23:30 UTC on 22 November is already the 23rd in Paris.
    await countUsageActivity(redis, 'messages', log, new Date('2026-11-22T23:30:00Z'));
    expect(calls).toEqual([
      ['hincrby', 'usage:activity:2026-11-23', 'messages', 1],
      ['expire', 'usage:activity:2026-11-23', USAGE_DAY_KEY_TTL_SECS],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never throws: a refused command is a warn naming the count it lost', async () => {
    const { redis } = fakeRedis(async () => [
      [new Error('OOM'), null],
      [null, 1],
    ]);
    const log = logger();
    await expect(
      countUsageActivity(redis, 'calls', log, new Date('2026-11-23T10:00:00Z'))
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/calls NOT counted on 2026-11-23.*OOM/)
    );
  });

  it('never throws when Redis is unreachable or the transaction was discarded', async () => {
    for (const answer of [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => null,
    ]) {
      const log = logger();
      await countUsageActivity(fakeRedis(answer).redis, 'messages', log);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('messages NOT counted'));
    }
  });
});
