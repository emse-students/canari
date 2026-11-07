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
import { RedisService } from '../common/redis';
import {
  LIVE_ARRIVALS_LOG_MAX,
  LIVE_ARRIVALS_PAGE,
  LIVE_ARRIVALS_TTL_MS,
  LIVE_SEAT_LEASE_MS,
  LIVE_VIEWER_CAP,
} from './live.constants';
import {
  COUNT_LIVE_SEATS_LUA,
  FORGET_ARRIVALS_LUA,
  LIVE_SEATS_KEY,
  LiveSeats,
  NOTE_ARRIVAL_LUA,
  READ_ARRIVALS_LUA,
  arrivalKeys,
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

  it('asks ONE script for the take, with the member, the cap, the lease and the live prefix', async () => {
    const { seats, calls } = seatsAnswering(async () => [1, 3, 2]);
    // The take answers the live's own count, not the host's (3 seated, 2 of them on this live).
    await expect(seats.take(LIVE, 'bob')).resolves.toBe(2);
    expect(calls).toEqual([
      {
        script: TAKE_SEAT_LUA,
        keys: [LIVE_SEATS_KEY],
        args: [seatMember(LIVE, 'bob'), LIVE_VIEWER_CAP, LIVE_SEAT_LEASE_MS, `${LIVE}:`],
      },
    ]);
  });

  it("reads the broadcaster's count with ONE read-only script, a number and nothing else", async () => {
    const { seats, calls } = seatsAnswering(async () => 4);
    await expect(seats.watching(LIVE.toUpperCase())).resolves.toBe(4);
    expect(calls).toEqual([
      {
        script: COUNT_LIVE_SEATS_LUA,
        keys: [LIVE_SEATS_KEY],
        args: [LIVE_SEAT_LEASE_MS, `${LIVE}:`],
      },
    ]);
  });

  it('answers no count, never a wrong one, when Redis fails or answers nonsense', async () => {
    for (const reply of [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => 'OK',
      async () => -1,
      async () => [1, 2],
    ]) {
      const { seats } = seatsAnswering(reply);
      await expect(seats.watching(LIVE)).resolves.toBeNull();
    }
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

  it('notes an arrival with the live-keyed scripts, and reads it back typed', async () => {
    const noted = seatsAnswering(async () => 1);
    await expect(noted.seats.noteArrival(LIVE.toUpperCase(), 'bob')).resolves.toBe(true);
    expect(noted.calls).toEqual([
      {
        script: NOTE_ARRIVAL_LUA,
        keys: arrivalKeys(LIVE),
        args: ['bob', LIVE_ARRIVALS_TTL_MS, LIVE_ARRIVALS_LOG_MAX],
      },
    ]);
    const read = seatsAnswering(async () => [3, 'bob', '2', 'eve', '3']);
    await expect(read.seats.readArrivals(LIVE, 1)).resolves.toEqual({
      top: 3,
      rows: [
        { userId: 'bob', seq: 2 },
        { userId: 'eve', seq: 3 },
      ],
    });
    const [, counter, log] = arrivalKeys(LIVE);
    expect(read.calls[0]).toMatchObject({ keys: [counter, log], args: [1, LIVE_ARRIVALS_PAGE] });
    const first = seatsAnswering(async () => [3]);
    await first.seats.readArrivals(LIVE, null);
    expect(first.calls[0].args).toEqual([-1, LIVE_ARRIVALS_PAGE]);
  });

  it('refuses an arrivals reply it did not write, rather than guess', async () => {
    for (const reply of ['OK', [1, 'bob'], [Number.NaN, 'bob', '1']]) {
      const { seats } = seatsAnswering(async () => reply);
      await expect(seats.readArrivals(LIVE, 0)).rejects.toThrow('unreadable');
    }
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
      // A grant with no count of its own (the reply of the script before the count existed).
      async () => [1, 3],
      async () => [1, 3, 0],
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
  /** The whole reply: `{granted, seated}` refused, `{1, seated, watching}` granted. */
  const takeReply = async (member: string, cap: number, lease = 30_000) =>
    (await redis.eval(
      TAKE_SEAT_LUA,
      1,
      key,
      member,
      cap,
      lease,
      `${member.split(':')[0]}:`
    )) as number[];
  /** The grant and the host's count only - what the cap's own tests read. */
  const take = async (member: string, cap: number, lease = 30_000) =>
    (await takeReply(member, cap, lease)).slice(0, 2);
  const watching = async (liveId: string, lease = 30_000) =>
    (await redis.eval(COUNT_LIVE_SEATS_LUA, 1, key, lease, seatMember(liveId, ''))) as number;

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

  it("counts ONE live's viewers, the same from the take and the broadcaster's read", async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    expect(await takeReply(seatMember(LIVE, 'a'), 5)).toEqual([1, 1, 1]);
    expect(await takeReply(seatMember(OTHER, 'a'), 5)).toEqual([1, 2, 1]);
    expect(await takeReply(seatMember(LIVE, 'b'), 5)).toEqual([1, 3, 2]);
    // A renewal is not a second viewer.
    expect(await takeReply(seatMember(LIVE, 'b'), 5)).toEqual([1, 3, 2]);
    expect(await watching(LIVE)).toBe(2);
    expect(await watching(OTHER)).toBe(1);
    // A viewer who leaves goes from the count at once.
    await redis.eval(RELEASE_SEAT_LUA, 1, key, seatMember(LIVE, 'a'));
    expect(await watching(LIVE)).toBe(1);
    // One whose lease lapsed (its last renewal written long ago) is not counted by the read, which
    // writes nothing, nor by the next take, which sweeps it.
    await redis.zadd(key, 0, seatMember(LIVE, 'b'));
    expect(await watching(LIVE)).toBe(0);
    expect(await redis.zscore(key, seatMember(LIVE, 'b'))).toBe('0');
    expect(await takeReply(seatMember(LIVE, 'c'), 5)).toEqual([1, 2, 1]);
    // A refusal at the cap carries no count.
    expect(await takeReply(seatMember(LIVE, 'd'), 2)).toEqual([0, 2]);
  });

  /**
   * THROUGH THE REAL `RedisService.evalScript` (its argument order, its key count): what the service
   * methods send is what the scripts expect. A KNOWN (non-fresh) note must still refresh the TTL -
   * the dedupe set lives as long as anybody takes a seat.
   */
  it('notes, reads and forgets arrivals through LiveSeats and the real RedisService', async () => {
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = URL!;
    const service = new RedisService();
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
    const seats = new LiveSeats(service);
    const keys = arrivalKeys(LIVE);
    try {
      await redis.del(...keys);
      await expect(seats.noteArrival(LIVE, 'bob')).resolves.toBe(true);
      // A shortened TTL, then a KNOWN viewer's note: not fresh, and the TTL is back to full.
      for (const k of keys) await redis.pexpire(k, 1_000);
      await expect(seats.noteArrival(LIVE.toUpperCase(), 'bob')).resolves.toBe(false);
      for (const k of keys) {
        expect(await redis.pttl(k)).toBeGreaterThan(1_000);
        expect(await redis.pttl(k)).toBeLessThanOrEqual(LIVE_ARRIVALS_TTL_MS);
      }
      await seats.noteArrival(LIVE, 'eve');
      await expect(seats.readArrivals(LIVE, null)).resolves.toEqual({ top: 2, rows: [] });
      await expect(seats.readArrivals(LIVE, 1)).resolves.toEqual({
        top: 2,
        rows: [{ userId: 'eve', seq: 2 }],
      });
      await seats.forgetArrivals(LIVE);
      expect(await redis.exists(...keys)).toBe(0);
      // The three keys share ONE hash tag: one slot on a cluster.
      expect(new Set(keys.map((k) => /\{([^}]+)\}/.exec(k)?.[1])).size).toBe(1);
    } finally {
      await redis.del(...keys);
      await service.onModuleDestroy();
    }
  });

  /**
   * THE ARRIVAL LOG (owner, 2026-11-07): once per viewer per live, ascending, a first poll reading
   * only the top, the log trimmed to its newest entries, every key expiring.
   */
  describe('the arrival log', () => {
    const keys = arrivalKeys(LIVE);
    const note = (viewer: string, max = 100) =>
      redis.eval(NOTE_ARRIVAL_LUA, 3, ...keys, viewer, 60_000, max) as Promise<number>;
    const read = (after: number, page = 50) =>
      redis.eval(READ_ARRIVALS_LUA, 2, keys[1], keys[2], after, page) as Promise<
        (string | number)[]
      >;
    beforeEach(async () => {
      await redis.del(...keys);
    });
    afterAll(async () => {
      await redis.del(...keys);
    });

    it('notes a viewer ONCE and numbers the arrivals in order', async () => {
      expect(await note('a')).toBe(1);
      expect(await note('b')).toBe(1);
      expect(await note('a')).toBe(0);
      expect(await read(0)).toEqual([2, 'a', '1', 'b', '2']);
    });

    it('a first poll reads the top and no history; a cursor reads only what is after it', async () => {
      await note('a');
      await note('b');
      expect(await read(-1)).toEqual([2]);
      expect(await read(1)).toEqual([2, 'b', '2']);
      expect(await read(2)).toEqual([2]);
    });

    it('keeps the newest entries only, the counter going on', async () => {
      for (const v of ['a', 'b', 'c', 'd']) await note(v, 2);
      expect(await read(0)).toEqual([4, 'c', '3', 'd', '4']);
    });

    it('every key expires, and the forget script deletes the three at once', async () => {
      await note('a');
      for (const k of keys) expect(await redis.pttl(k)).toBeGreaterThan(0);
      expect(await redis.eval(FORGET_ARRIVALS_LUA, 3, ...keys)).toBe(3);
      expect(await redis.exists(...keys)).toBe(0);
    });

    it('is per live: another live has its own log and counter', async () => {
      const OTHER = arrivalKeys('22222222-2222-4222-8222-222222222222');
      await note('a');
      await redis.eval(NOTE_ARRIVAL_LUA, 3, ...OTHER, 'a', 60_000, 100);
      expect(await redis.eval(READ_ARRIVALS_LUA, 2, OTHER[1], OTHER[2], 0, 50)).toEqual([
        1,
        'a',
        '1',
      ]);
      await redis.del(...OTHER);
    });
  });

  it('lets the whole set expire once nobody renews it', async () => {
    await take('a', 1, 30_000);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });
});
