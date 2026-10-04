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
 *
 * A `pending` row in neither set is a roster seat nothing follows. The full reasoning is on
 * `InvitationsController.getDeviceMemberships`, the first reader.
 */
export interface PendingMembershipFacts {
  welcomed: Set<string>;
  locked: Set<string>;
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
 * A Redis that is down answers for none of the groups, which is the conservative direction:
 * `addInFlight` false only ever makes a client ask a member, and asking a member is the old path.
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
  if (pendingGroupIds.length === 0) return { welcomed, locked };

  const queued = await queuedMessageRepo.find({
    select: { groupId: true },
    where: { deviceId, isWelcome: true, groupId: In(pendingGroupIds) },
  });
  for (const q of queued) if (q.groupId) welcomed.add(q.groupId);

  // `mget` answers null per absent key, so a group nobody is adding into costs nothing.
  const held = await redis.mget(pendingGroupIds.map(addLockKey)).catch((e: unknown) => {
    logger.warn(
      `[PENDING_FACTS] device=${deviceId} add-lock read failed (${String(e).slice(0, 120)}) - ` +
        `answering addInFlight=false for ${pendingGroupIds.length} group(s)`
    );
    return pendingGroupIds.map(() => null);
  });
  pendingGroupIds.forEach((g, i) => {
    if (held[i] !== null && held[i] !== undefined) locked.add(g);
  });
  return { welcomed, locked };
}
