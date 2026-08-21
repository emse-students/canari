import { EntityManager, In } from 'typeorm';
import type Redis from 'ioredis';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';

/** How many Redis keys one `DEL` carries, so a large reap never spreads one huge argument list. */
const REDIS_DEL_CHUNK = 500;

/** Per-table row counts removed by {@link deleteGroupOwnedRows}, for the caller's log line. */
export type GroupOwnedRowCounts = {
  queuedMessages: number;
  members: number;
  deviceMemberships: number;
  commitLog: number;
  groupInfo: number;
  invites: number;
  dismissals: number;
};

/** Sum of every table in a {@link GroupOwnedRowCounts}. */
export function totalGroupOwnedRows(counts: GroupOwnedRowCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * Deletes every database row the given groups own.
 *
 * THIS LIST IS THE DEFINITION OF "WHAT A GROUP OWNS", and it is an ALLOWLIST: seven tables named
 * one by one, checkable against `src/entities/` (every entity carrying a `groupId` is here). It
 * exists because the two places that end a group each carried their own shorter list, and both
 * were wrong in the same direction - measured on prod 2026-08-18, 21 of 69 `mls_group_info` rows,
 * 293 of 452 `mls_commit_log`, 220 `queued_message` and 3 of 4 `group_invites` named a group absent
 * from `dm_groups`. `mls_group_info` had no collector at all, so those rows were permanent.
 *
 * Takes an `EntityManager` rather than repositories so a caller that also drops the `dm_groups`
 * row can pass a transactional one and do both atomically. That is not tidiness: with two
 * statements outside a transaction there is a window in which the group is gone and its rows are
 * not, which is precisely the state the orphan sweep is built to find - a sweep racing the reaper
 * that deletes for it.
 *
 * The deletes are sequential on purpose. A transactional `EntityManager` holds ONE query runner,
 * so issuing them through `Promise.all` would multiplex a single connection for no gain.
 *
 * **`dismissals` IS THE ONE MEMBER OF THIS SET THAT MAY OUTLIVE THE GROUP, AND `groupRowSurvives`
 * IS WHERE THAT IS DECIDED.** `UserDismissedGroup` is not a fact about the group at all - it is a
 * fact about a PERSON, recording that they asked for a conversation to be gone from all their
 * devices. Its own entity says so twice: stored as text rather than a foreign key "so it outlives
 * the group row", and "independent of the group's own lifecycle". Discovery reads it to tell "I
 * dismissed this" from "somebody else deleted it", and only the first of those may be purged
 * silently; without the marker a tombstone shows the deleted banner instead.
 *
 * So a SOFT delete must keep it - the tombstone remains, discovery still runs against it, and the
 * question the marker answers is still live. A HARD delete may drop it, because nothing will ever
 * ask again. Measured the day this option was added: three delete routes had just been moved onto
 * this list, all three soft, and all three were deleting the marker; 25 rows went with a by-hand
 * repair of tombstoned residue before anybody noticed, which is 25 conversations that will show a
 * banner to somebody who had asked for them to be gone.
 *
 * @param manager entity manager, transactional when the group row goes in the same unit of work
 * @param groupIds groups whose rows are to be removed; empty is a no-op
 * @param groupRowSurvives true for a SOFT delete, where the `dm_groups` tombstone is kept - the
 *   per-user dismissal markers are then left alone, and `dismissals` comes back 0
 * @returns how many rows each table gave up
 */
export async function deleteGroupOwnedRows(
  manager: EntityManager,
  groupIds: string[],
  { groupRowSurvives = false }: { groupRowSurvives?: boolean } = {}
): Promise<GroupOwnedRowCounts> {
  const empty: GroupOwnedRowCounts = {
    queuedMessages: 0,
    members: 0,
    deviceMemberships: 0,
    commitLog: 0,
    groupInfo: 0,
    invites: 0,
    dismissals: 0,
  };
  if (groupIds.length === 0) return empty;

  const where = { groupId: In(groupIds) };

  return {
    queuedMessages: (await manager.getRepository(QueuedMessage).delete(where)).affected ?? 0,
    members: (await manager.getRepository(GroupMember).delete(where)).affected ?? 0,
    deviceMemberships:
      (await manager.getRepository(DeviceGroupMembership).delete(where)).affected ?? 0,
    commitLog: (await manager.getRepository(MlsCommitLog).delete(where)).affected ?? 0,
    groupInfo: (await manager.getRepository(MlsGroupInfo).delete(where)).affected ?? 0,
    invites: (await manager.getRepository(GroupInvite).delete(where)).affected ?? 0,
    dismissals: groupRowSurvives
      ? 0
      : ((await manager.getRepository(UserDismissedGroup).delete(where)).affected ?? 0),
  };
}

/**
 * Deletes the Redis keys the given groups own: `history:`, `group:members:` and `pending_welcome:`.
 *
 * Separate from {@link deleteGroupOwnedRows} because Redis cannot join the SQL transaction, so the
 * caller runs this AFTER the commit. That order is deliberate: a crash between the two leaves keys
 * whose group is gone, which `cleanupOrphanedRedisGroups` already collects, whereas the reverse
 * order would strip a live group's history if the transaction then rolled back.
 *
 * `mls:addlock:` and `mls:commitlock:` are NOT here: both are written with an `EX` TTL (60 s and
 * 5 s), so they collect themselves and a purge naming them would only pretend to be doing work.
 */
export async function deleteGroupRedisKeys(redis: Redis, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;

  const keys = groupIds.flatMap((id) => [
    `history:${id}`,
    `group:members:${id}`,
    `pending_welcome:${id}`,
  ]);

  for (let i = 0; i < keys.length; i += REDIS_DEL_CHUNK) {
    await redis.del(...keys.slice(i, i + REDIS_DEL_CHUNK));
  }
}
