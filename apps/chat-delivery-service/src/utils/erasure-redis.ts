import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { deleteGroupRedisKeys } from './group-purge';

/**
 * THE REDIS HALF OF AN ACCOUNT ERASURE, read off Redis itself and never off a row.
 *
 * WHY NOT OFF THE ROWS: the database half deletes the rows that name the account's groups, and a
 * run can die between those deletes and the Redis ones - a 1:1 DM's tombstone, above all, commits
 * before the DM's keys go. The retry then finds no row, so every Redis fact naming the account is
 * found where it lives: by scanning, matched on the account's own prefix. Every step is idempotent,
 * so a retry repeats it whole.
 *
 * Wiki: docs/wiki/account-erasure.md.
 */

const logger = new Logger('ErasureRedis');

/** Items per `SCAN`/`SSCAN`/`HSCAN` round trip - a hint to Redis, bounding round trips only. */
const SCAN_COUNT = 500;

/**
 * `value` with every Redis glob metacharacter escaped, so it MATCHes only itself. A user id is
 * visible ASCII with no ':' (core-service `user-id.ts`), which still allows `*`, `?`, `[` and `\`.
 */
export function escapeRedisGlob(value: string): string {
  return value.replace(/[*?[\]\\^]/g, (c) => `\\${c}`);
}

/** Every key matching `pattern`, across every `SCAN` page. */
async function keysMatching(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    keys.push(...page);
  } while (cursor !== '0');
  return [...new Set(keys)];
}

/** Every member of the set `key` matching `pattern`, across every `SSCAN` page. */
async function setMembersMatching(redis: Redis, key: string, pattern: string): Promise<string[]> {
  const members: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.sscan(key, cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    members.push(...page);
  } while (cursor !== '0');
  return [...new Set(members)];
}

/** Every field of the hash `key` matching `pattern`, across every `HSCAN` page. */
async function hashFieldsMatching(redis: Redis, key: string, pattern: string): Promise<string[]> {
  const fields: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.hscan(key, cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    // `HSCAN` answers field, value, field, value...
    for (let i = 0; i < page.length; i += 2) fields.push(page[i]);
  } while (cursor !== '0');
  return [...new Set(fields)];
}

/** The `MATCH` pattern of every `<userId>:<deviceId>` key, member or field. */
function devicesOf(userId: string): string {
  return `${escapeRedisGlob(userId)}:*`;
}

/**
 * The Redis set naming the 1:1 DMs an account erasure is tombstoning (`erasure:dms:<userId>`).
 *
 * WHY IT EXISTS: a DM's tombstone deletes every row that named it for the account, in a transaction
 * that commits BEFORE the DM's Redis keys go (`tombstoneGroups`). A run that dies between the two
 * leaves keys - the DM's `history:` stream among them - that no row of the account names. This set
 * is written before the tombstone and removed only once the keys went ({@link purgeErasedDmKeys}),
 * so it is the one fact still naming those DMs after the tombstone. It lives for one run, never by
 * a timer.
 */
function erasedDmsKey(userId: string): string {
  return `erasure:dms:${userId}`;
}

/** Names `dmIds` in the account's erasure marker ({@link erasedDmsKey}), before their tombstone. */
export async function markErasedDms(
  redis: Redis,
  userId: string,
  dmIds: readonly string[]
): Promise<void> {
  if (dmIds.length === 0) return;
  await redis.sadd(erasedDmsKey(userId), ...dmIds);
}

/**
 * Deletes every Redis key of the DMs the account's erasure marker names, then the marker itself -
 * in that order, so a run that dies or throws in between leaves the marker for the retry.
 *
 * @returns how many DMs the marker named.
 */
export async function purgeErasedDmKeys(redis: Redis, userId: string): Promise<number> {
  const dmIds = await redis.smembers(erasedDmsKey(userId));
  if (dmIds.length === 0) return 0;
  await deleteGroupRedisKeys(redis, dmIds);
  await redis.del(erasedDmsKey(userId));
  return dmIds.length;
}

/**
 * Every route of `userId` still in a routing set (`group:members:<g>`), by group - found with
 * `SSCAN MATCH` on the account's prefix, so no set is read whole.
 *
 * Only FOUND here: whether a route may go depends on the seat behind it, which is the database's,
 * read under that group's seat lock (`MessagingService.removeUnseatedRoutes`).
 */
export async function findRoutesOfUser(
  redis: Redis,
  userId: string
): Promise<Map<string, string[]>> {
  const prefix = 'group:members:';
  const found = new Map<string, string[]>();
  for (const key of await keysMatching(redis, `${prefix}*`)) {
    const routes = await setMembersMatching(redis, key, devicesOf(userId));
    if (routes.length > 0) found.set(key.slice(prefix.length), routes);
  }
  return found;
}

/** What {@link eraseUserRedisTraces} removed, per kind, for the caller's log line. */
export interface UserRedisTraces {
  /** Members of `pending_welcome:<g>` naming one of the account's devices. */
  pendingWelcome: number;
  /** Fields of `group:parting:<g>` naming one of the account's devices. */
  parting: number;
  /** Frames in another member's `pending_welcome_notify:<user>` naming the account as requester. */
  notifyFrames: number;
  /** Keys of the account itself: its own notify list, presence and session keys. */
  ownKeys: number;
}

/**
 * Removes every Redis fact that names the account's devices, apart from the routes (which
 * {@link findRoutesOfUser} finds and the seat lock decides):
 *
 * - a stored `welcome_request` (`pending_welcome:<g>`, members `<userId>:<deviceId>`);
 * - a removal waiting for its commit (`group:parting:<g>`, fields `<userId>:<deviceId>`);
 * - the account's own pending notifications (`pending_welcome_notify:<userId>`), and every frame in
 *   another member's list that names the account as its requester;
 * - its presence and session keys (`user:online:<userId>:*`, `addressing:sessions:<userId>:*`).
 *
 * A notify frame that does not parse is logged and left: it names nobody this code can read.
 */
export async function eraseUserRedisTraces(redis: Redis, userId: string): Promise<UserRedisTraces> {
  const traces: UserRedisTraces = { pendingWelcome: 0, parting: 0, notifyFrames: 0, ownKeys: 0 };
  const devices = devicesOf(userId);

  for (const key of await keysMatching(redis, 'pending_welcome:*')) {
    const theirs = await setMembersMatching(redis, key, devices);
    if (theirs.length === 0) continue;
    await redis.srem(key, ...theirs);
    traces.pendingWelcome += theirs.length;
  }

  for (const key of await keysMatching(redis, 'group:parting:*')) {
    const theirs = await hashFieldsMatching(redis, key, devices);
    if (theirs.length === 0) continue;
    await redis.hdel(key, ...theirs);
    traces.parting += theirs.length;
  }

  const ownNotify = `pending_welcome_notify:${userId}`;
  for (const key of await keysMatching(redis, 'pending_welcome_notify:*')) {
    if (key === ownNotify) continue;
    for (const frame of new Set(await redis.lrange(key, 0, -1))) {
      let requester: unknown;
      try {
        requester = (JSON.parse(frame) as { requesterUserId?: unknown }).requesterUserId;
      } catch (e) {
        logger.warn(
          `[INTERNAL_DELETE] a frame of ${key.split(':')[0]} does not parse and is left: ${String(e)}`
        );
        continue;
      }
      if (requester !== userId) continue;
      traces.notifyFrames += await redis.lrem(key, 0, frame);
    }
  }

  const own = [
    ownNotify,
    ...(await keysMatching(redis, `user:online:${devices}`)),
    ...(await keysMatching(redis, `addressing:sessions:${devices}`)),
  ];
  traces.ownKeys = await redis.del(...own);
  return traces;
}
