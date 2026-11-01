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
 * THE FURTHER-DEVICE SELF-JOIN IS SHUT UNTIL EVERY MEMBER CLIENT READS IT AS AN ORDINARY ADDED DEVICE
 * (D1 gated on D2/D3, review of #2832). A `1.5.1`-`1.5.4` member writes a member's further device
 * entering by its own commit as an accusation and withholds history from it, so while such clients
 * may still be members, the server does not open the door: the conversation base is served WITHOUT
 * the asking device's seat (the client then reads `seat_unreadable` and does not join), and a
 * further device's `selfJoinIfNobody` ask is stored, queued and woken exactly as any other.
 *
 * LIFTED BY ONE LINE, in its own pull request, once `minClientVersion` is at least the release
 * carrying D2/D3 (`1.5.5`) - `docs/wiki/legacy-compatibility.md` carries the condition. A constant
 * rather than an environment switch: the condition is a fact about the shipped clients, the same on
 * every estate, and a reviewed commit is its record.
 */
export const FURTHER_DEVICE_SELF_JOIN_OPEN = false;

/**
 * Whether a member could still answer, read in the same request (D5 of
 * docs/wiki/protocols/mls-availability-no-holder.md): `liveHolderDevices` counts every device but
 * the asking one - the requester's OWN other devices included, since one of them coming back re-adds
 * this one - with an `active` row in the group AND a KeyPackage published within the retention window
 * (`RETENTION_WINDOW_MS` - the one liveness window this service keeps); `wakeSent` says whether this
 * very request woke member phones in the background. A member who simply did not open the app tonight
 * is still a live holder, so the client never calls such a group unopenable.
 */
export interface HolderLiveness {
  liveHolderDevices: number;
  wakeSent: boolean;
}

/**
 * The facts a `no_peer_online` answer carries about the requester's group (`noHolderFacts`): the
 * stored base's epochs - `null` when none was ever published - the requester's own seat, and whether
 * a member could still answer ({@link HolderLiveness}).
 */
export interface NoHolderFacts {
  base: { baseEpoch: number; activeEpoch: number } | null;
  seat: DeviceSeat;
  holders: HolderLiveness;
}

/** A seat as one log field: `pending(welcome=..,adding=..)`, `active` or `none`. */
export function describeSeat(seat: DeviceSeat): string {
  return seat.status === 'pending'
    ? `pending(welcome=${seat.welcomeQueued},adding=${seat.addInFlight ?? 'unknown'})`
    : seat.status;
}
