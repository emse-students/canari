/**
 * The host's viewer cap (WP-L4, docs/wiki/services/lives.md "The viewer cap").
 *
 * Two halves. The service's TYPING runs everywhere, over a fake Redis: a full host is 503
 * `LIVE_FULL` with the cap, a Redis that does not answer is 503 `LIVE_SEATS_UNAVAILABLE` - never the
 * same code, because "live complet" on a Redis outage would be a lie the client cannot detect.
 *
 * The script's ATOMICITY needs a real Redis, so that half is GATED ON `SOCIAL_IT_REDIS_URL`, like the
 * PostgreSQL integration files:
 *
 *   docker run -d --rm -p 56379:6379 redis:8.10-alpine
 *   SOCIAL_IT_REDIS_URL=redis://localhost:56379 bun run test -- live-seats
 *
 * Each run uses its own key, so it never touches a seat set anything else reads. An expired seat is
 * WRITTEN with an old score rather than waited for: no wall clock is asserted.
 */
import { HttpStatus } from '@nestjs/common';
import Redis from 'ioredis';
import type { RedisService } from '../common/redis';
import { LIVE_SEAT_LEASE_MS, LIVE_VIEWER_CAP } from './live.constants';
import {
  LIVE_SEATS_KEY,
  LiveSeats,
  RELEASE_LIVE_SEATS_LUA,
  RELEASE_SEAT_LUA,
  TAKE_SEAT_LUA,
  seatMember,
} from './live-seats';

const LIVE = '11111111-1111-4111-8111-111111111111';

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus: () => number; getResponse: () => unknown };
    return { status: err.getStatus(), body: err.getResponse() };
  }
  throw new Error('expected a refusal, got an answer');
}

function seatsAnswering(reply: () => Promise<unknown>) {
  const calls: { script: string; keys: readonly string[]; args: readonly unknown[] }[] = [];
  const redis = {
    evalScript: async (script: string, keys: readonly string[], args: readonly unknown[]) => {
      calls.push({ script, keys, args });
      return reply();
    },
  } as unknown as RedisService;
  return { seats: new LiveSeats(redis), calls };
}

describe('the viewer cap, as the service types it', () => {
  it('is sized on the uplink: floor(90 Mb/s x 0.8 / 3 Mb/s) = 24 seats, a 30 s lease', () => {
    expect(LIVE_VIEWER_CAP).toBe(24);
    expect(LIVE_SEAT_LEASE_MS).toBe(30_000);
  });

  it('asks ONE script for the take, with the member, the cap and the lease', async () => {
    const { seats, calls } = seatsAnswering(async () => [1, 3]);
    await seats.take(LIVE, 'bob');
    expect(calls).toEqual([
      {
        script: TAKE_SEAT_LUA,
        keys: [LIVE_SEATS_KEY],
        args: [seatMember(LIVE, 'bob'), LIVE_VIEWER_CAP, LIVE_SEAT_LEASE_MS],
      },
    ]);
  });

  it('keys a seat by the live id lower-cased, so a leave spelled in upper case frees the take', () => {
    expect(seatMember('ABCDEF00-0000-4000-8000-000000000000', 'bob')).toBe(
      'abcdef00-0000-4000-8000-000000000000:bob'
    );
  });

  it('frees an ended live with ONE script naming its member prefix', async () => {
    const { seats, calls } = seatsAnswering(async () => 2);
    await expect(seats.releaseLive(LIVE)).resolves.toBe(2);
    expect(calls).toEqual([
      { script: RELEASE_LIVE_SEATS_LUA, keys: [LIVE_SEATS_KEY], args: [`${LIVE}:`] },
    ]);
  });

  it('refuses a full host with 503 LIVE_FULL and the cap - the "live complet" screen', async () => {
    const { seats } = seatsAnswering(async () => [0, LIVE_VIEWER_CAP]);
    expect(await refusal(seats.take(LIVE, 'carol'))).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'LIVE_FULL', viewerCap: LIVE_VIEWER_CAP },
    });
  });

  it('never calls a Redis failure or an unreadable reply "full"', async () => {
    for (const reply of [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => 'OK',
      async () => [7, 1],
    ]) {
      const { seats } = seatsAnswering(reply);
      expect(await refusal(seats.take(LIVE, 'bob'))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { code: 'LIVE_SEATS_UNAVAILABLE' },
      });
    }
    const { seats } = seatsAnswering(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await refusal(seats.release(LIVE, 'bob'))).body).toEqual({
      code: 'LIVE_SEATS_UNAVAILABLE',
    });
  });
});

const URL = process.env.SOCIAL_IT_REDIS_URL;
const maybe = URL ? describe : describe.skip;

maybe('the seat script against a real Redis', () => {
  const key = `live:seats:it:${Math.random().toString(36).slice(2, 10)}`;
  let redis: Redis;
  const take = async (member: string, cap: number, lease = 30_000) =>
    (await redis.eval(TAKE_SEAT_LUA, 1, key, member, cap, lease)) as [number, number];

  beforeAll(() => {
    redis = new Redis(URL!);
  });
  beforeEach(async () => {
    await redis.del(key);
  });
  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('grants EXACTLY the cap when far more viewers arrive at once', async () => {
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, i) => take(`${LIVE}:viewer-${i}`, 5))
    );
    expect(answers.filter(([granted]) => granted === 1)).toHaveLength(5);
    expect(await redis.zcard(key)).toBe(5);
  });

  it('renews a held seat without counting it twice, even at the cap', async () => {
    expect(await take('a', 2)).toEqual([1, 1]);
    expect(await take('b', 2)).toEqual([1, 2]);
    expect(await take('a', 2)).toEqual([1, 2]);
    expect(await take('c', 2)).toEqual([0, 2]);
  });

  it('frees a seat whose lease lapsed, and one given back', async () => {
    expect(await take('a', 1)).toEqual([1, 1]);
    // Its last renewal written as long ago: the next take sweeps it.
    await redis.zadd(key, 0, 'a');
    expect(await take('b', 1)).toEqual([1, 1]);
    expect(await redis.eval(RELEASE_SEAT_LUA, 1, key, 'b')).toBe(1);
    expect(await redis.eval(RELEASE_SEAT_LUA, 1, key, 'b')).toBe(0);
    expect(await take('c', 1)).toEqual([1, 1]);
  });

  it("gives back every seat of ONE live and no other live's", async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    await take(seatMember(LIVE, 'a'), 5);
    await take(seatMember(LIVE, 'b'), 5);
    await take(seatMember(OTHER, 'a'), 5);
    expect(await redis.eval(RELEASE_LIVE_SEATS_LUA, 1, key, seatMember(LIVE, ''))).toBe(2);
    expect(await redis.zrange(key, '0', '-1')).toEqual([seatMember(OTHER, 'a')]);
    expect(await redis.eval(RELEASE_LIVE_SEATS_LUA, 1, key, seatMember(LIVE, ''))).toBe(0);
  });

  it('lets the whole set expire once nobody renews it', async () => {
    await take('a', 1, 30_000);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });
});
