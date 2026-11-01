/**
 * The banner claim (`push-claim.ts`) against a REAL Redis: its point is that `SET ... NX GET` is ONE
 * atomic step that both writes the first owner and hands every later caller the owner that won, and
 * a fake can only repeat what this file believes Redis does. Gated on `CHAT_DELIVERY_IT_REDIS_URL`
 * and run by CI beside `addressing.redis`, against the production digest:
 *
 *   docker run -d --rm -p 127.0.0.1:46379:6379 redis:8.10-alpine
 *   CHAT_DELIVERY_IT_REDIS_URL=redis://localhost:46379 bun run test -- push-claim.redis
 *
 * Each run uses its own ids, so it never touches a key anything else reads.
 */
import Redis from 'ioredis';
import { PUSH_CLAIM_TTL_S, claimBanner, pushClaimKey, readBannerOwners } from './push-claim';

const URL = process.env.CHAT_DELIVERY_IT_REDIS_URL;
const maybe = URL ? describe : describe.skip;

maybe('the banner claim against Redis', () => {
  let redis: Redis;
  const run = `it-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (n: string) => `${run}-${n}`;

  beforeAll(() => {
    redis = new Redis(URL!);
  });
  afterAll(async () => {
    const keys = await redis.keys(`push-claim:${run}-*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('the first claim wins and every later one reads it back, whichever side asks', async () => {
    expect(await claimBanner(redis, id('a'), 'push')).toBe('push');
    expect(await claimBanner(redis, id('a'), 'ack')).toBe('push');
    expect(await claimBanner(redis, id('a'), 'push')).toBe('push');
    expect(await claimBanner(redis, id('b'), 'ack')).toBe('ack');
    expect(await claimBanner(redis, id('b'), 'push')).toBe('ack');
  });

  it('two claims racing for one row agree on ONE owner', async () => {
    const answers = await Promise.all([
      claimBanner(redis, id('race'), 'ack'),
      claimBanner(redis, id('race'), 'push'),
    ]);
    expect(answers[0]).toBe(answers[1]);
  });

  it('a claim carries its garbage-collection TTL, and a read never claims', async () => {
    await claimBanner(redis, id('ttl'), 'push');
    const ttl = await redis.ttl(pushClaimKey(id('ttl')));
    expect(ttl).toBeGreaterThan(PUSH_CLAIM_TTL_S - 60);
    const owners = await readBannerOwners(redis, [id('ttl'), id('never')]);
    expect([...owners]).toEqual([[id('ttl'), 'push']]);
    expect(await redis.exists(pushClaimKey(id('never')))).toBe(0);
  });
});
