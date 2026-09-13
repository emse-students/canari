import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

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
 * The value a holder writes into the key. It identifies a DEVICE, not a user: the same account on
 * two devices must not be able to release the other's lock.
 */
export function addLockOwner(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * Deletes the key only if this device still owns it, atomically.
 *
 * A separate GET + DEL is a race: the lock can expire and be retaken by another device between the
 * two, and the release would then delete a lock it does not hold.
 */
const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Takes the group's add-lock for this device, or reports that someone else holds it.
 *
 * `SET NX EX` in one command: the acquisition and the expiry are the same write, so a crash cannot
 * leave a lock with no lifetime.
 *
 * @returns `true` if this device now holds the lock.
 */
export async function acquireAddLock(
  redis: Redis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor
): Promise<boolean> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const result = await redis.set(addLockKey(holder.groupId), owner, 'EX', ADD_LOCK_TTL_SEC, 'NX');
  const acquired = result === 'OK';
  logger.log(
    `[ADD_LOCK] group=${holder.groupId} owner=${owner} acquired=${acquired} ` +
      `ttl=${ADD_LOCK_TTL_SEC}s via=${door}`
  );
  return acquired;
}

/**
 * Releases the group's add-lock if this device still holds it.
 *
 * `released=false` is not an error: the lock may have expired, or the caller may never have held
 * it. It is logged because it is the only trace an expiry-under-its-holder leaves.
 *
 * @returns `true` if this call is what deleted the key.
 */
export async function releaseAddLock(
  redis: Redis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor
): Promise<boolean> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const deleted = await redis.eval(RELEASE_IF_OWNER, 1, addLockKey(holder.groupId), owner);
  const released = deleted === 1;
  logger.log(
    `[RELEASE_LOCK] group=${holder.groupId} owner=${owner} released=${released} via=${door}`
  );
  return released;
}
