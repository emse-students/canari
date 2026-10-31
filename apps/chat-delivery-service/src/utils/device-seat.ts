import type { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import type { QueuedMessage } from '../entities/queued-message.entity';
import { addInFlightOf, readPendingMembershipFacts } from './pending-membership-facts';

/**
 * One device's seat in one group, in the terms the client's one-door reading takes
 * (`readWelcomeOwedFromSeat`): `none` (no row), `active`, or `pending` with `welcomeQueued` and -
 * when the add lock was read - `addInFlight`. `addInFlight` is left out when the add lock could not
 * be read: unknown, never `false`.
 *
 * SERVED WITH A BASE, AND READ AFTER IT - the order is the guarantee. An Add writes its newcomers'
 * `pending` seats and stores the base for the epoch it creates in one transaction, and holds the add
 * lock until its Welcomes are queued; so a base that already carries an Add is answered with that
 * Add's seat, and a joiner never builds on it as if nobody owed it a Welcome (channel-encryption
 * section 20). A key group's base (`getDistributionGroup`) and a conversation's
 * (`GET mls/group-info/:groupId?deviceId=`) both carry it.
 */
export type DeviceSeat =
  | { status: 'none' | 'active' }
  | { status: 'pending'; welcomeQueued: boolean; addInFlight?: boolean };

/**
 * Reads {@link DeviceSeat} for `userId:deviceId` in `groupId`. The caller reads the base FIRST.
 *
 * `rows`, when the caller already holds the user's rows for the group, saves the query.
 */
export async function readDeviceSeat(
  deps: {
    deviceGroupRepo: Pick<Repository<DeviceGroupMembership>, 'find'>;
    queuedMessageRepo: Pick<Repository<QueuedMessage>, 'find'>;
    redis: Pick<Redis, 'mget'>;
    logger: Pick<Logger, 'warn'>;
  },
  groupId: string,
  userId: string,
  deviceId: string,
  rows?: Array<{ deviceId: string; status: 'pending' | 'active' }>
): Promise<DeviceSeat> {
  const userRows =
    rows ??
    (await deps.deviceGroupRepo.find({
      where: { groupId, userId },
      select: { deviceId: true, status: true },
    }));
  const row = userRows.find((r) => r.deviceId === deviceId);
  if (!row) return { status: 'none' };
  if (row.status !== 'pending') return { status: row.status };
  const facts = await readPendingMembershipFacts(
    deps.queuedMessageRepo,
    deps.redis,
    deviceId,
    [groupId],
    deps.logger
  );
  const addInFlight = addInFlightOf(facts, groupId);
  return {
    status: 'pending',
    welcomeQueued: facts.welcomed.has(groupId),
    ...(addInFlight === undefined ? {} : { addInFlight }),
  };
}

/**
 * The facts a `no_peer_online` answer carries about the requester's group (`noHolderFacts`): the
 * stored base's epochs - `null` when none was ever published - and the requester's own seat.
 */
export interface NoHolderFacts {
  base: { baseEpoch: number; activeEpoch: number } | null;
  seat: DeviceSeat;
}

/** A seat as one log field: `pending(welcome=..,adding=..)`, `active` or `none`. */
export function describeSeat(seat: DeviceSeat): string {
  return seat.status === 'pending'
    ? `pending(welcome=${seat.welcomeQueued},adding=${seat.addInFlight ?? 'unknown'})`
    : seat.status;
}
