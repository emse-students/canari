/**
 * The check-and-publish scripts of an addressed conversation frame (history-answer-addressing, rule
 * 6) and of a join-ask frame, against a REAL Redis - their point is that the check and the publish
 * are ONE atomic step, which a fake cannot judge. Gated on `CHAT_DELIVERY_IT_REDIS_URL`, run by CI in
 * `boot-nest-apps` against the production digest, and refused there if it skipped:
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
  type SessionCapability,
  addressingSessionsKey,
  declaresAddressedHistory,
  joinAskSessionsKey,
  publishIfAddressable,
} from './addressing';

/**
 * THE HISTORY SCRIPT EVERY SHIPPED CHAT-DELIVERY RUNS, frozen as it shipped: it compares each session
 * value WHOLE. The gateway's recorded shape must keep satisfying it, in both deploy directions - a
 * newer gateway beside an older chat-delivery (a rollback, or a rollout in either order).
 */
const SHIPPED_ADDRESSABLE_PUBLISH_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[4] then return 0 end
local declared = redis.call('HVALS', KEYS[2])
if #declared == 0 then return 0 end
for _, value in ipairs(declared) do
  if value ~= ARGV[3] then return 0 end
end
if ARGV[1] ~= '' then redis.call('PUBLISH', ARGV[1], ARGV[2]) end
return 1
`;

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

maybe('the check-and-publish scripts against a real Redis', () => {
  const user = `it-${Math.random().toString(36).slice(2, 10)}`;
  const device = 'd1';
  const presence = `user:online:${user}:${device}`;
  const hash = addressingSessionsKey(user, device);
  const joinAsk = joinAskSessionsKey(user, device);
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
    await redis.del(presence, hash, joinAsk);
  });
  afterAll(async () => {
    await redis.del(presence, hash, joinAsk);
    await subscriber.quit();
    await redis.quit();
  });

  /**
   * EVERY publishing call goes through here: it runs the script, then publishes a FENCE on the same
   * channel and waits for it. Redis delivers one channel in order, so once the fence is in, the frame
   * is in too if it was ever published - and nothing of this case can land after the next case's
   * `beforeEach` cleared `received` (a frame published without a fence did, and failed the next case).
   */
  const fenced = async (published: Promise<boolean>, payload: string) => {
    const sent = await published;
    await redis.publish(channel, `fence-${payload}`);
    await waitFor(() => received.includes(`fence-${payload}`));
    return sent;
  };
  const send = (payload: string, capability?: SessionCapability) =>
    fenced(publishIfAddressable(redis, user, device, { channel, payload }, capability), payload);
  const sendShipped = (payload: string) =>
    fenced(
      redis
        .eval(
          SHIPPED_ADDRESSABLE_PUBLISH_LUA,
          2,
          presence,
          hash,
          channel,
          payload,
          ADDRESSED_HISTORY_CAPABILITY,
          PRESENCE_SESSIONS
        )
        .then((answer) => Number(answer) === 1),
      payload
    );
  const frames = () => received.filter((m) => !m.startsWith('fence-'));

  /** One session as the current gateway records it: both hashes, the same field. */
  const session = async (field: string, history: boolean, ask: boolean) => {
    await redis.hset(hash, field, history ? ADDRESSED_HISTORY_CAPABILITY : '-');
    await redis.hset(joinAsk, field, ask ? JOIN_ASK_CAPABILITY : '-');
  };

  it('publishes when every session declared, under a current presence value', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, false);
    await session('p2:7', true, false);

    expect(await send('frame-1')).toBe(true);
    expect(frames()).toEqual(['frame-1']);
  });

  it('publishes nothing when ONE session did not declare', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, false);
    await session('p2:7', false, false);

    expect(await send('frame-2')).toBe(false);
    expect(frames()).toEqual([]);
  });

  it("publishes nothing under an older gateway's `true`, nor with no session recorded", async () => {
    await redis.set(presence, 'true');
    await session('p1:1', true, true);
    expect(await send('frame-3')).toBe(false);
    expect(await send('frame-3b', JOIN_ASK_CAPABILITY)).toBe(false);

    await redis.set(presence, PRESENCE_SESSIONS);
    await redis.del(hash, joinAsk);
    expect(await send('frame-4')).toBe(false);
    expect(await send('frame-4b', JOIN_ASK_CAPABILITY)).toBe(false);
    expect(frames()).toEqual([]);
  });

  it('reads a session that declared both capabilities as holding each of them', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, true);

    expect(await send('frame-5')).toBe(true);
    expect(await send('frame-6', JOIN_ASK_CAPABILITY)).toBe(true);
    expect(frames()).toEqual(['frame-5', 'frame-6']);
  });

  /** An older client's session (history only) beside a current one: no join-ask frame at all. */
  it('publishes no join-ask frame while ONE session did not declare it', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, true);
    await session('p2:7', true, false);

    expect(await send('frame-7', JOIN_ASK_CAPABILITY)).toBe(false);
    expect(frames()).toEqual([]);
  });

  /**
   * A session an OLDER gateway recorded writes no twin field: it counts as not declaring join-ask,
   * however its history value reads.
   */
  it('publishes no join-ask frame to a session with no twin field (an older gateway recorded it)', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, true);
    await redis.hset(hash, 'old:3', ADDRESSED_HISTORY_CAPABILITY);

    expect(await send('frame-8', JOIN_ASK_CAPABILITY)).toBe(false);
    expect(await send('frame-9')).toBe(true);
    expect(frames()).toEqual(['frame-9']);
  });

  /**
   * Review of #2442: the history value is byte-identical to what every gateway before join-ask
   * wrote, so the history script every SHIPPED chat-delivery runs answers the current shape exactly
   * as the current one does - mixed sessions included.
   */
  it('answers the shipped history script the same on the current shape, mixed sessions included', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, true);
    await session('p2:7', true, false);
    expect(await sendShipped('frame-10')).toBe(true);
    expect(await send('frame-11')).toBe(true);

    await session('p3:2', false, true);
    expect(await sendShipped('frame-12')).toBe(false);
    expect(await send('frame-13')).toBe(false);
    expect(frames()).toEqual(['frame-10', 'frame-11']);
  });

  it('answers the check alone without publishing anything', async () => {
    await redis.set(presence, PRESENCE_SESSIONS);
    await session('p1:1', true, true);

    expect(await publishIfAddressable(redis, user, device)).toBe(true);
    expect(await publishIfAddressable(redis, user, device, undefined, JOIN_ASK_CAPABILITY)).toBe(
      true
    );
    expect(frames()).toEqual([]);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  // Bounded by iterations, not a clock assertion: a delivered pub/sub message lands within a few
  // event-loop turns of the PUBLISH reply on the same host.
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}
