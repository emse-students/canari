/**
 * The check-and-publish script of an addressed conversation frame (history-answer-addressing, rule
 * 6), against a REAL Redis - its point is that the check and the publish are ONE atomic step, which a
 * fake cannot judge. Gated on `CHAT_DELIVERY_IT_REDIS_URL`, run by CI in `boot-nest-apps` against the
 * production digest, and refused there if it skipped:
 *
 *   docker run -d --rm -p 127.0.0.1:46379:6379 redis:8.10-alpine
 *   CHAT_DELIVERY_IT_REDIS_URL=redis://localhost:46379 bun run test -- addressing.redis
 *
 * Each run uses its own user id, so it never touches a key anything else reads.
 */
import Redis from 'ioredis';
import {
  ADDRESSED_HISTORY_CAPABILITY,
  JOIN_ASK_CAPABILITY,
  PRESENCE_SESSIONS,
  addressingSessionsKey,
  declaresAddressedHistory,
  publishIfAddressable,
} from './addressing';

describe('declaresAddressedHistory', () => {
  it('reads the capability out of a comma-separated caps value, and nothing else', () => {
    expect(declaresAddressedHistory(ADDRESSED_HISTORY_CAPABILITY)).toBe(true);
    expect(declaresAddressedHistory(`other, ${ADDRESSED_HISTORY_CAPABILITY}`)).toBe(true);
    expect(declaresAddressedHistory('addressed-history-2')).toBe(false);
    expect(declaresAddressedHistory(undefined)).toBe(false);
  });
});

const URL = process.env.CHAT_DELIVERY_IT_REDIS_URL;
const maybe = URL ? describe : describe.skip;

maybe('the check-and-publish script against a real Redis', () => {
  const user = `it-${Math.random().toString(36).slice(2, 10)}`;
  const device = 'd1';
  const presence = `user:online:${user}:${device}`;
  const hash = addressingSessionsKey(user, device);
  const channel = `it:addressing:${user}`;
  let redis: Redis;
  let subscriber: Redis;
  let received: string[];

  beforeAll(async () => {
    redis = new Redis(URL!);
    subscriber = new Redis(URL!);
    received = [];
    await subscriber.subscribe(channel);
    subscriber.on('message', (_c, message) => received.push(message));
  });
  beforeEach(async () => {
    received.length = 0;
    await redis.del(presence, hash);
  });
  afterAll(async () => {
    await redis.del(presence, hash);
    await subscriber.quit();
    await redis.quit();
  });

  /**
   * Runs the script, then publishes a FENCE on the same channel and waits for it: Redis delivers one
   * channel in order, so once the fence is in, the frame is in too if it was ever published.
   */
  const send = async (payload: string) => {
    const sent = await publishIfAddressable(redis, user, device, { channel, payload });
    await redis.publish(channel, `fence-${payload}`);
    await waitFor(() => received.includes(`fence-${payload}`));
    return sent;
  };
  const frames = () => received.filter((m) => !m.startsWith('fence-'));

  it('publishes when every session declared, under a current presence value', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.hset(
      hash,
      'p1:1',
      ADDRESSED_HISTORY_CAPABILITY,
      'p2:7',
      ADDRESSED_HISTORY_CAPABILITY
    );

    expect(await send('frame-1')).toBe(true);
    expect(frames()).toEqual(['frame-1']);
  });

  it('publishes nothing when ONE session did not declare', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.hset(hash, 'p1:1', ADDRESSED_HISTORY_CAPABILITY, 'p2:7', '-');

    expect(await send('frame-2')).toBe(false);
    expect(frames()).toEqual([]);
  });

  it("publishes nothing under an older gateway's `true`, nor with no session recorded", async () => {
    await redis.set(presence, 'true');
    await redis.hset(hash, 'p1:1', ADDRESSED_HISTORY_CAPABILITY);
    expect(await send('frame-3')).toBe(false);

    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.del(hash);
    expect(await send('frame-4')).toBe(false);
    expect(frames()).toEqual([]);
  });

  /** A session declaring several capabilities is a LIST: each is found among its items. */
  it('reads a session that declared several capabilities as holding each of them', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.hset(hash, 'p1:1', `${ADDRESSED_HISTORY_CAPABILITY},${JOIN_ASK_CAPABILITY}`);

    expect(await send('frame-5')).toBe(true);
    const ask = await publishIfAddressable(
      redis,
      user,
      device,
      { channel, payload: 'frame-6' },
      JOIN_ASK_CAPABILITY
    );
    expect(ask).toBe(true);
  });

  /** An older client's session (history only) beside a current one: no join-ask frame at all. */
  it('publishes no join-ask frame while ONE session did not declare it', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.hset(
      hash,
      'p1:1',
      `${ADDRESSED_HISTORY_CAPABILITY},${JOIN_ASK_CAPABILITY}`,
      'p2:7',
      ADDRESSED_HISTORY_CAPABILITY
    );

    const sent = await publishIfAddressable(
      redis,
      user,
      device,
      { channel, payload: 'frame-7' },
      JOIN_ASK_CAPABILITY
    );
    await redis.publish(channel, 'fence-frame-7');
    await waitFor(() => received.includes('fence-frame-7'));

    expect(sent).toBe(false);
    expect(frames()).toEqual([]);
  });

  it('answers the check alone without publishing anything', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.hset(hash, 'p1:1', ADDRESSED_HISTORY_CAPABILITY);

    expect(await publishIfAddressable(redis, user, device)).toBe(true);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  // Bounded by iterations, not a clock assertion: a delivered pub/sub message lands within a few
  // event-loop turns of the PUBLISH reply on the same host.
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}
