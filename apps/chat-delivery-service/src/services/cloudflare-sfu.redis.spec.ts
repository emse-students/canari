/**
 * The Cloudflare proxy's two seat scripts (WP-GC3) against a REAL Redis: their point is that the
 * cap check and the seat write are ONE step, and that a leave releases only the session it names -
 * which the JS reading in `cloudflare-sfu.service.spec.ts` cannot judge. Gated on
 * `CHAT_DELIVERY_IT_REDIS_URL`, run by CI in `boot-nest-apps` beside `addressing.redis`, and refused
 * there if it skipped:
 *
 *   docker run -d --rm -p 127.0.0.1:46379:6379 redis:8.10-alpine
 *   CHAT_DELIVERY_IT_REDIS_URL=redis://localhost:46379 bun run test -- cloudflare-sfu.redis
 *
 * Each run uses its own room id, so it never touches a key anything else reads.
 */
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  CLAIM_SEAT_LUA,
  RELEASE_SEAT_LUA,
  cloudflareSeatsKey,
  cloudflareTracksKey,
} from './cloudflare-sfu.service';

const url = process.env.CHAT_DELIVERY_IT_REDIS_URL;
const maybe = url ? describe : describe.skip;

maybe('the Cloudflare seat scripts against Redis', () => {
  let redis: Redis;
  let room: string;

  beforeAll(() => {
    redis = new Redis(url!);
  });
  afterAll(async () => {
    await redis.quit();
  });
  beforeEach(() => {
    room = `it-${randomUUID()}`;
  });
  afterEach(async () => {
    await redis.del(cloudflareSeatsKey(room), cloudflareTracksKey(room, 's-a'));
  });

  const claim = (user: string, session: string, cap = 2) =>
    redis.eval(CLAIM_SEAT_LUA, 1, cloudflareSeatsKey(room), user, session, String(cap), '60000');
  const release = (user: string, session: string) =>
    redis.eval(
      RELEASE_SEAT_LUA,
      2,
      cloudflareSeatsKey(room),
      cloudflareTracksKey(room, session),
      user,
      session
    );

  it('seats up to the cap and refuses the next user, with the TTL set', async () => {
    expect(await claim('a', 's-a')).toEqual([1, '']);
    expect(await claim('b', 's-b')).toEqual([2, '']);
    expect(await claim('c', 's-c')).toEqual([-1, '']);
    expect(await redis.hgetall(cloudflareSeatsKey(room))).toEqual({ a: 's-a', b: 's-b' });
    expect(await redis.pttl(cloudflareSeatsKey(room))).toBeGreaterThan(0);
  });

  it('a seated user replaces its session at the cap, and is told which one it replaced', async () => {
    await claim('a', 's-a');
    await claim('b', 's-b');
    expect(await claim('a', 's-a2')).toEqual([2, 's-a']);
  });

  it('twenty users racing for two seats: exactly two are seated', async () => {
    const answers = (await Promise.all(
      Array.from({ length: 20 }, (_, i) => claim(`u${i}`, `s${i}`))
    )) as [number, string][];
    expect(answers.filter(([seats]) => seats > 0)).toHaveLength(2);
    expect(await redis.hlen(cloudflareSeatsKey(room))).toBe(2);
  });

  it('a leave releases only the session it names, and drops its tracks', async () => {
    await claim('a', 's-a');
    await redis.sadd(cloudflareTracksKey(room, 's-a'), 'audio');
    await claim('a', 's-a2');
    expect(await release('a', 's-a')).toEqual([0, 1]);
    expect(await redis.hget(cloudflareSeatsKey(room), 'a')).toBe('s-a2');

    await redis.del(cloudflareSeatsKey(room));
    await claim('a', 's-a');
    expect(await release('a', 's-a')).toEqual([1, 0]);
    expect(await redis.exists(cloudflareTracksKey(room, 's-a'))).toBe(0);
  });
});
