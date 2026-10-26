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
 * The set of devices a refused acquire asked to be TOLD when the lock is released
 * ({@link acquireAddLock}'s `notifyRelease`), one JSON `{userId, deviceId}` per member. It lives
 * exactly as long as the lock it waits on: every write sets its expiry to the lock's own remaining
 * life, and the release that deletes the lock takes and deletes it in the same script.
 */
export function addLockWaitersKey(groupId: string): string {
  return `mls:addlock:waiters:${groupId}`;
}

/**
 * The tail every release script shares, run once the lock is deleted: takes the waiters and
 * deletes their set IN THE SAME SCRIPT, so a waiter is told by exactly one release, and none that
 * registers after this release is lost - it registers against a lock that is gone and reads
 * `PTTL` 0 ({@link REGISTER_WAITER}). Answers `{1, waiters}`; a script that deleted nothing answers
 * `{0}`.
 */
const TAKE_WAITERS =
  "redis.call('del', KEYS[1]) " +
  "local w = redis.call('smembers', KEYS[2]) " +
  "redis.call('del', KEYS[2]) " +
  'return {1, w}';

/**
 * Deletes the key only if it holds exactly ARGV[1] - this acquisition's value - atomically, and
 * takes its waiters ({@link TAKE_WAITERS}).
 *
 * A separate GET + DEL is a race: the lock can expire and be retaken between the two, and the
 * release would then delete a lock it does not hold.
 */
const RELEASE_IF_TOKEN = `if redis.call('get', KEYS[1]) == ARGV[1] then ${TAKE_WAITERS} else return {0} end`;

/**
 * LEGACY - a release that names no token (`legacy-compatibility.md`): deletes the key if this
 * device holds it under ANY acquisition - the bare owner a server before the token wrote (ARGV[1]),
 * or a token value of the same owner (prefix ARGV[2]). It keeps a client that predates the token
 * releasing at all; it is exactly as blind as the release it replaces, and no worse.
 */
const RELEASE_IF_OWNER_LEGACY =
  "local v = redis.call('get', KEYS[1]) " +
  'if v and (v == ARGV[1] or string.sub(v, 1, string.len(ARGV[2])) == ARGV[2]) ' +
  `then ${TAKE_WAITERS} else return {0} end`;

/**
 * A refused acquire that asked to be told: reads the lock's remaining life and, only while the lock
 * still lives, adds ARGV[1] to its waiters and sets the set's expiry to that same remaining life -
 * ONE script, so the lock cannot be released between the read and the registration. A lock already
 * gone answers its `PTTL` (`-2`) and registers nothing: the waiter reads 0 ms and re-plans at once.
 */
const REGISTER_WAITER =
  "local p = redis.call('pttl', KEYS[1]) " +
  "if p > 0 then redis.call('sadd', KEYS[2], ARGV[1]) redis.call('pexpire', KEYS[2], p) end " +
  'return p';

/**
 * Extends the lock to a full {@link ADD_LOCK_TTL_SEC} only if it holds exactly ARGV[1] - this
 * acquisition's value - and its waiters' set with it, atomically. Answers 1 when renewed, 0 when
 * the lock is no longer this acquisition's (expired, or taken since).
 */
const RENEW_IF_TOKEN =
  "if redis.call('get', KEYS[1]) == ARGV[1] then " +
  "redis.call('expire', KEYS[1], ARGV[2]) " +
  "if redis.call('exists', KEYS[2]) == 1 then redis.call('expire', KEYS[2], ARGV[2]) end " +
  'return 1 else return 0 end';

/** The control frame a waiter receives when the lock it waits on is released. */
export interface AddLockReleasedFrame {
  type: 'add_lock_released';
  groupId: string;
}

/** What `redis` must do for the lock: the commands used and the one control-frame channel. */
export type AddLockRedis = Pick<Redis, 'set' | 'pttl' | 'eval' | 'publish'>;

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
 *
 * `notifyRelease` (exactly a JSON `true`) is a refused caller asking to be TOLD when the holder
 * releases ({@link REGISTER_WAITER}): the release publishes an `add_lock_released` frame to it, so a
 * waiter acts when the lock ends instead of sleeping to the `PTTL` this still answers - which stays
 * the waiter's backstop for a holder that never releases (cut, or dead). Only a client that routes
 * the frame sends the flag, so no client receives a frame it does not know.
 */
export async function acquireAddLock(
  redis: AddLockRedis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor,
  notifyRelease?: unknown
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
  const notify = notifyRelease === true;
  const pttl = notify
    ? Number(
        await redis.eval(
          REGISTER_WAITER,
          2,
          key,
          addLockWaitersKey(holder.groupId),
          JSON.stringify({ userId: holder.userId, deviceId: holder.deviceId })
        )
      )
    : await redis.pttl(key);
  const retryAfterMs = pttl > 0 ? pttl : 0;
  logger.log(
    `[ADD_LOCK] group=${holder.groupId} owner=${owner} acquired=false retryAfterMs=${retryAfterMs} via=${door}${notify && pttl > 0 ? ' notify=true' : ''}`
  );
  return { acquired: false, retryAfterMs };
}

/**
 * Extends the group's add-lock to a full {@link ADD_LOCK_TTL_SEC} if it is still the acquisition
 * `token` names ({@link RENEW_IF_TOKEN}). An Add that rebuilds on a lost race does more round trips
 * per attempt, so a long chain of them could outlive the lifetime sized for ONE attempt; each
 * rebuild renews first, and a lock that is no longer its own ends the Add instead of letting a
 * second holder add alongside it.
 *
 * `renewed=false` is an answer, logged: the lock expired under its holder, or was taken since.
 *
 * @returns `true` if the lock is this acquisition's, now for a full lifetime.
 */
export async function renewAddLock(
  redis: AddLockRedis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor,
  token: string
): Promise<boolean> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const renewed =
    (await redis.eval(
      RENEW_IF_TOKEN,
      2,
      addLockKey(holder.groupId),
      addLockWaitersKey(holder.groupId),
      addLockValue(owner, token),
      String(ADD_LOCK_TTL_SEC)
    )) === 1;
  logger.log(`[RENEW_LOCK] group=${holder.groupId} owner=${owner} renewed=${renewed} via=${door}`);
  return renewed;
}

/** The waiters a release took, parsed; an entry that is not the shape written is logged and skipped. */
function parseWaiters(logger: Logger, groupId: string, raw: unknown): AddLockHolder[] {
  if (!Array.isArray(raw)) return [];
  const out: AddLockHolder[] = [];
  for (const entry of raw) {
    try {
      const w = JSON.parse(String(entry)) as { userId?: unknown; deviceId?: unknown };
      if (typeof w.userId === 'string' && typeof w.deviceId === 'string') {
        out.push({ groupId, userId: w.userId, deviceId: w.deviceId });
        continue;
      }
    } catch {
      // Logged below, with the entry.
    }
    logger.warn(
      `[RELEASE_LOCK] group=${groupId} a waiter entry is unreadable, skipped: ${String(entry).slice(0, 80)}`
    );
  }
  return out;
}

/**
 * Tells each waiter the lock is released, on the gateway's control-frame path (the device it
 * names, nothing else). The releasing device itself is never told. Best-effort: a waiter that is
 * not told wakes at the `PTTL` its refusal answered, so a failure is logged and never thrown.
 *
 * @returns how many waiters a frame was published to.
 */
async function tellWaiters(
  redis: AddLockRedis,
  logger: Logger,
  releaser: AddLockHolder,
  waiters: readonly AddLockHolder[]
): Promise<number> {
  const frame: AddLockReleasedFrame = { type: 'add_lock_released', groupId: releaser.groupId };
  const proto = Buffer.from(JSON.stringify(frame)).toString('base64');
  const targets = waiters.filter(
    (w) => !(w.userId === releaser.userId && w.deviceId === releaser.deviceId)
  );
  try {
    await Promise.all(
      targets.map((w) =>
        redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: w.userId,
            deviceId: w.deviceId,
            proto,
            // The gateway's generic "relay this base64 JSON control frame" flag.
            isWelcomeRequest: true,
            groupId: releaser.groupId,
            senderId: releaser.userId,
            senderDeviceId: releaser.deviceId,
          })
        )
      )
    );
    return targets.length;
  } catch (e) {
    logger.warn(
      `[RELEASE_LOCK] group=${releaser.groupId} ${targets.length} waiter(s) could not be told - each wakes at the end its refusal was told: ${String(e)}`
    );
    return 0;
  }
}

/**
 * Releases the group's add-lock if it is still the acquisition `token` names - or, with no token
 * (a client that predates it), if this device holds it at all (the legacy path).
 *
 * `released=false` is not an error: the lock may have expired, been retaken, or never been held. It
 * is logged because it is the only trace an expiry-under-its-holder leaves.
 *
 * `owed` is the client's own statement that this release was OWED - sent by a page that found the
 * marker of an acquisition it never saw released (a reload, a lost answer) before acquiring again.
 * Only that case and a slow Add whose TTL ran out under it print `released=false by=token`, and only
 * the client knows which one it is: the line ends ` owed=true` for exactly a JSON `true`, and is
 * otherwise unchanged.
 *
 * A release that deleted the lock TELLS ITS WAITERS ({@link acquireAddLock}'s `notifyRelease`), and
 * its line ends ` told=N` when it told any.
 *
 * @returns `true` if this call is what deleted the key.
 */
export async function releaseAddLock(
  redis: AddLockRedis,
  logger: Logger,
  holder: AddLockHolder,
  door: AddLockDoor,
  token?: string,
  owed?: unknown
): Promise<boolean> {
  const owner = addLockOwner(holder.userId, holder.deviceId);
  const key = addLockKey(holder.groupId);
  const waitersKey = addLockWaitersKey(holder.groupId);
  const answer = token
    ? await redis.eval(RELEASE_IF_TOKEN, 2, key, waitersKey, addLockValue(owner, token))
    : await redis.eval(RELEASE_IF_OWNER_LEGACY, 2, key, waitersKey, owner, `${owner}#`);
  const [deleted, waiters] = Array.isArray(answer) ? answer : [answer, []];
  const released = deleted === 1;
  const told = released
    ? await tellWaiters(redis, logger, holder, parseWaiters(logger, holder.groupId, waiters))
    : 0;
  logger.log(
    `[RELEASE_LOCK] group=${holder.groupId} owner=${owner} released=${released} by=${token ? 'token' : 'owner-legacy'} via=${door}${owed === true ? ' owed=true' : ''}${told > 0 ? ` told=${told}` : ''}`
  );
  return released;
}
