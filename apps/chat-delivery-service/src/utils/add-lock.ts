import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'crypto';

/**
 * HOW LONG THE ADD-LOCK LIVES, AND THE ONLY PLACE THAT IS DECIDED.
 *
 * Sized on the worst-case path the lock actually covers - bulk add + state persist (~5-8 s) +
 * validated commit + the Welcome loop - after the original 10 s expired mid-operation and let two
 * devices commit in parallel, forking the epoch on the successor (H1).
 *
 * It is a SERVER number on purpose. It used to be a `ttlMs` field on the JWT route's body, clamped
 * to 1-60 s, which no caller ever set to anything but this value - while the PushSecret twin, which
 * has no such field, hard-coded **15 s**. So the same lock, on the same key, lived 30 s when taken
 * from the foreground and half that when taken from the Android background service, which is the
 * SLOWER of the two paths and therefore the one an expiring lock hurts. A lifetime the caller may
 * ask for is a lifetime the two doors can disagree about; the lock lives on the server, so the
 * number does too.
 */
export const ADD_LOCK_TTL_SEC = 30;

/**
 * Which door the lock was taken through: `jwt` for a foreground client, `push` for the background
 * service that cannot mint a JWT. It labels the log line and decides NOTHING - both doors take the
 * same lock, on the same key, for the same time.
 */
export type AddLockDoor = 'jwt' | 'push';

/** Who is taking the lock, and on what. */
export interface AddLockHolder {
  groupId: string;
  userId: string;
  deviceId: string;
}

/** The Redis key serialising add commits for one group. */
export function addLockKey(groupId: string): string {
  return `mls:addlock:${groupId}`;
}

/**
 * Who holds the lock: a DEVICE, not a user - the same account on two devices must not be able to
 * release the other's lock. The prefix of every value the key holds.
 */
export function addLockOwner(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * The value ONE acquisition writes: its owner and a token minted for it alone.
 *
 * WHY A TOKEN, AND NOT THE OWNER ALONE: one device takes the lock through two doors (the foreground
 * client and the Android background service) and, in one page, more than once. A release checked
 * against the owner alone deletes WHICHEVER of those acquisitions holds the key - a release sent
 * late (its first send was lost with the connection) freed a live lock taken since, mid-Add: the
 * two-committers-one-epoch class (H1) the lock exists to prevent. A release carrying its token
 * deletes the acquisition it names, or nothing.
 */
export function addLockValue(owner: string, token: string): string {
  return `${owner}#${token}`;
}

/**
 * Deletes the key only if it holds exactly ARGV[1] - this acquisition's value - atomically.
 *
 * A separate GET + DEL is a race: the lock can expire and be retaken between the two, and the
 * release would then delete a lock it does not hold.
 */
const RELEASE_IF_TOKEN =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * LEGACY - a release that names no token (`legacy-compatibility.md`): deletes the key if this
 * device holds it under ANY acquisition - the bare owner a server before the token wrote (ARGV[1]),
 * or a token value of the same owner (prefix ARGV[2]). It keeps a client that predates the token
 * releasing at all; it is exactly as blind as the release it replaces, and no worse.
 */
const RELEASE_IF_OWNER_LEGACY =
  "local v = redis.call('get', KEYS[1]) " +
  'if v and (v == ARGV[1] or string.sub(v, 1, string.len(ARGV[2])) == ARGV[2]) ' +
  "then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * What an acquisition answers:
 * - taken: the token to release it with;
 * - refused: how long the key has left to live, in ms (`PTTL`), the server's own fact - so a waiter
 *   wakes when the lock CAN no longer be held, instead of polling or waiting for an event the
 *   holder's release does not send. `0` when the key vanished between the two reads.
 */
export type AddLockAcquisition =
  | { acquired: true; token: string }
  | { acquired: false; retryAfterMs: number };

/**
 * Takes the group's add-lock for this device, or reports that someone else holds it - and until
 * when.
 *
 * `SET NX EX` in one command: the acquisition and the expiry are the same write, so a crash cannot
 * leave a lock with no lifetime.
 */
export async function acquireAddLock(
  redis: Redis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor
): Promise<AddLockAcquisition> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const token = randomUUID();
  const key = addLockKey(holder.groupId);
  const result = await redis.set(key, addLockValue(owner, token), 'EX', ADD_LOCK_TTL_SEC, 'NX');
  if (result === 'OK') {
    logger.log(
      `[ADD_LOCK] group=${holder.groupId} owner=${owner} acquired=true ttl=${ADD_LOCK_TTL_SEC}s via=${door}`
    );
    return { acquired: true, token };
  }
  const pttl = await redis.pttl(key);
  const retryAfterMs = pttl > 0 ? pttl : 0;
  logger.log(
    `[ADD_LOCK] group=${holder.groupId} owner=${owner} acquired=false retryAfterMs=${retryAfterMs} via=${door}`
  );
  return { acquired: false, retryAfterMs };
}

/**
 * Releases the group's add-lock if it is still the acquisition `token` names - or, with no token
 * (a client that predates it), if this device holds it at all (the legacy path).
 *
 * `released=false` is not an error: the lock may have expired, been retaken, or never been held. It
 * is logged because it is the only trace an expiry-under-its-holder leaves.
 *
 * @returns `true` if this call is what deleted the key.
 */
export async function releaseAddLock(
  redis: Redis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor,
  token?: string
): Promise<boolean> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const key = addLockKey(holder.groupId);
  const deleted = token
    ? await redis.eval(RELEASE_IF_TOKEN, 1, key, addLockValue(owner, token))
    : await redis.eval(RELEASE_IF_OWNER_LEGACY, 1, key, owner, `${owner}#`);
  const released = deleted === 1;
  logger.log(
    `[RELEASE_LOCK] group=${holder.groupId} owner=${owner} released=${released} by=${token ? 'token' : 'owner-legacy'} via=${door}`
  );
  return released;
}
