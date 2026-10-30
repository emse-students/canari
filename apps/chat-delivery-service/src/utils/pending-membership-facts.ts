import type { Logger } from '@nestjs/common';
import { In, type Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { QueuedMessage } from '../entities/queued-message.entity';
import { addLockKey } from './add-lock';

/**
 * The two facts that say WHICH KIND of `pending` a device membership is, for a set of groups.
 *
 * - `welcomed` - groups for which a `queued_message` carrying a Welcome exists for THIS device.
 * - `locked` - groups whose add lock is held right now, so an Add really is in flight.
 * - `lockUnread` - the add locks could not be read at all, so `locked` says NOTHING about any group
 *   of this call. Every reader answers `addInFlight` as unknown (`undefined`) then, never `false`.
 *
 * A `pending` row in neither set, with the locks read, is a roster seat nothing follows. The full
 * reasoning is on `InvitationsController.getDeviceMemberships`, the first reader.
 */
export interface PendingMembershipFacts {
  welcomed: Set<string>;
  locked: Set<string>;
  lockUnread: boolean;
}

/**
 * `addInFlight` for one group, as every reader serialises it: unknown when the locks were not read.
 * ONE spelling, so no reader can turn an unread lock back into a `false`.
 */
export function addInFlightOf(facts: PendingMembershipFacts, groupId: string): boolean | undefined {
  return facts.lockUnread ? undefined : facts.locked.has(groupId);
}

/**
 * Reads {@link PendingMembershipFacts} for `deviceId` over `pendingGroupIds`, in two round trips
 * for the whole set - never one per row.
 *
 * ONE IMPLEMENTATION, BECAUSE TWO ENDPOINTS CARRY THE ANSWER. `GET mls/device-memberships` asks it
 * for a device's whole membership set, and `GET mls/users/:userId/groups` asks it for the rows it
 * lists, so a device that only ever READS can still learn it was given a seat nobody honoured. Two
 * copies of this partition would be two definitions of "stranded".
 *
 * A REDIS THAT IS DOWN ANSWERS NOTHING, NOT "NO ADD" (`lockUnread`). It used to answer `false` for
 * every group, on the premise that `addInFlight: false` only ever made a client ask a member. Since
 * 2026-10-30 that fact also guards the external-join door of a key group (`externalJoin`'s
 * `welcomeOwed: 'ask'`): read as `false`, an unread lock is a seat nothing follows, and the device
 * joins over the Add that holds the lock. Unknown makes every client reading `null`, and a `null`
 * reading opens no door that pass.
 */
export async function readPendingMembershipFacts(
  queuedMessageRepo: Pick<Repository<QueuedMessage>, 'find'>,
  redis: Pick<Redis, 'mget'>,
  deviceId: string,
  pendingGroupIds: string[],
  logger: Pick<Logger, 'warn'>
): Promise<PendingMembershipFacts> {
  const welcomed = new Set<string>();
  const locked = new Set<string>();
  if (pendingGroupIds.length === 0) return { welcomed, locked, lockUnread: false };

  const queued = await queuedMessageRepo.find({
    select: { groupId: true },
    where: { deviceId, isWelcome: true, groupId: In(pendingGroupIds) },
  });
  for (const q of queued) if (q.groupId) welcomed.add(q.groupId);

  // `mget` answers null per absent key, so a group nobody is adding into costs nothing.
  let held: (string | null)[];
  try {
    held = await redis.mget(pendingGroupIds.map(addLockKey));
  } catch (e) {
    logger.warn(
      `[PENDING_FACTS] device=${deviceId} add-lock read failed (${String(e).slice(0, 120)}) - ` +
        `answering addInFlight=unknown for ${pendingGroupIds.length} group(s)`
    );
    return { welcomed, locked, lockUnread: true };
  }
  pendingGroupIds.forEach((g, i) => {
    if (held[i] !== null && held[i] !== undefined) locked.add(g);
  });
  return { welcomed, locked, lockUnread: false };
}
