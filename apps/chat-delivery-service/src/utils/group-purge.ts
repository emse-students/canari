import { EntityManager, In, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type Redis from 'ioredis';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';

/** How many Redis keys one `DEL` carries, so a large reap never spreads one huge argument list. */
const REDIS_DEL_CHUNK = 500;

/** Keys per `SCAN` round trip. Redis treats it as a hint, so this only bounds the round trips. */
const REDIS_SCAN_COUNT = 500;

/**
 * The column every owned table joins to `dm_groups` on. One name, because every entity in the
 * allowlist declares the property `groupId` and this repository uses TypeORM's default naming, so
 * the column is spelt the same in all of them. A rename would fail loudly on the next sweep rather
 * than quietly return nothing.
 */
const GROUP_ID_COLUMN = 'groupId';

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
 * THE DEFINITION OF "WHAT A GROUP OWNS", AND THE ONLY ONE.
 *
 * IT IS ONE ARRAY BECAUSE REMOVING THE RESIDUE AND FINDING IT ARE THE SAME LIST READ TWICE.
 * {@link deleteGroupOwnedRows} walks it to delete; {@link findOrphanGroupIds} walks it to ask which
 * groups still own something while their `dm_groups` row is gone. Those were two hand-written
 * lists, the second two tables long, so a group whose only residue was a commit log or a stored
 * base was invisible to the sweep built to collect exactly that. As one array they cannot drift: a
 * table added here is swept AND discovered, or it is in neither.
 *
 * The count key travels with the entity, so the per-table report is the same list as well.
 * `dm_user_dismissed_groups` is deliberately absent - it is swept only by a HARD delete, and is
 * never a way to FIND a group; see {@link deleteGroupOwnedRows}.
 */
const GROUP_OWNED_TABLES: readonly {
  readonly count: keyof GroupOwnedRowCounts;
  readonly entity: EntityTarget<ObjectLiteral>;
}[] = [
  { count: 'queuedMessages', entity: QueuedMessage },
  { count: 'members', entity: GroupMember },
  { count: 'deviceMemberships', entity: DeviceGroupMembership },
  { count: 'commitLog', entity: MlsCommitLog },
  { count: 'groupInfo', entity: MlsGroupInfo },
  { count: 'invites', entity: GroupInvite },
];

/** A {@link GroupOwnedRowCounts} where nothing was removed - the answer to an empty id list. */
function noRowsRemoved(): GroupOwnedRowCounts {
  return {
    queuedMessages: 0,
    members: 0,
    deviceMemberships: 0,
    commitLog: 0,
    groupInfo: 0,
    invites: 0,
    dismissals: 0,
  };
}

/**
 * Deletes every database row the given groups own, from {@link GROUP_OWNED_TABLES}.
 *
 * {@link GROUP_OWNED_TABLES} plus `dm_user_dismissed_groups` is an ALLOWLIST: seven tables named
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
  const counts = noRowsRemoved();
  if (groupIds.length === 0) return counts;

  const where = { [GROUP_ID_COLUMN]: In(groupIds) };

  for (const { count, entity } of GROUP_OWNED_TABLES) {
    counts[count] = (await manager.getRepository(entity).delete(where)).affected ?? 0;
  }
  if (!groupRowSurvives) {
    counts.dismissals =
      (await manager.getRepository(UserDismissedGroup).delete(where)).affected ?? 0;
  }
  return counts;
}

/**
 * Group ids that own rows in {@link GROUP_OWNED_TABLES} while their `dm_groups` row is gone - the
 * residue of a deletion that did not finish.
 *
 * ONE `SELECT` PER TABLE IN THE ALLOWLIST, generated from it. This used to be a hand-written union
 * over two of them, `dm_group_members` and `dm_device_group_memberships`, which is a second, much
 * shorter definition of what a group leaves behind: a group whose members had already gone but
 * whose commit log, stored base, invites or queued frames had not was invisible to the one sweep
 * built to collect precisely that, and stayed invisible for ever - an absent group has no
 * tombstone, so the 90-day reaper never reaches it either.
 *
 * TOMBSTONES ARE NOT ORPHANS. The join is on presence alone, so a soft-deleted group - which still
 * has its row - is never named here; its residue is the reaper's, and collecting it from this
 * sweep would hide the delete path that left it (see `fetchMessages`).
 *
 * `queued_message.groupId` IS NULLABLE, and a system frame addressed to no group at all would
 * otherwise satisfy "no matching row in `dm_groups`" and be reported as an orphan with a null id.
 * Excluded explicitly rather than filtered afterwards, because the filter would have to know which
 * tables can hold a null.
 *
 * Table names come from the entity metadata rather than from literals, so this query says exactly
 * what {@link deleteGroupOwnedRows} deletes from.
 */
export async function findOrphanGroupIds(manager: EntityManager): Promise<string[]> {
  const groupTable = manager.getRepository(Group).metadata.tableName;
  const sql = GROUP_OWNED_TABLES.map(({ entity }) => {
    const table = manager.getRepository(entity).metadata.tableName;
    return (
      `SELECT DISTINCT t."${GROUP_ID_COLUMN}" AS "${GROUP_ID_COLUMN}" FROM "${table}" t ` +
      `LEFT JOIN "${groupTable}" g ON g.id = t."${GROUP_ID_COLUMN}" ` +
      `WHERE g.id IS NULL AND t."${GROUP_ID_COLUMN}" IS NOT NULL`
    );
  }).join('\nUNION\n');

  const rows: { groupId: string }[] = await manager.query(sql);
  return rows.map((r) => r.groupId);
}

/**
 * ENDS THE GIVEN GROUPS: the tombstone, everything they own, and their Redis keys - ONE unit of
 * work, and the only way a group ends.
 *
 * Three routes ended a group and each wrote this sequence out: the user-facing
 * `DELETE mls/groups/:groupId`, the internal retirement of a scope's distribution group, and the
 * DM half of an account deletion. They agreed on the hard part - {@link deleteGroupOwnedRows} is
 * already the one definition of what a group owns - and what stayed copied was the ORDER and the
 * FLAGS around it, which is exactly what drifted: both internal routes once wrote the tombstone
 * with no sweep at all, and because the row deliberately survives, the orphan sweep - which only
 * finds groups with NO row - could never collect what they left. It was permanent until the 90-day
 * reaper. Measured on prod 2026-08-21: seven `queued_message` rows redelivered on every connection
 * for five hours, each a frame the device could neither decrypt nor ACK.
 *
 * `groupRowSurvives` is not a parameter here, and that is the point: this function IS the soft
 * delete, the tombstone is what lets a lagging device OBSERVE the deletion rather than infer it,
 * and the per-user dismissal markers are facts about people that outlive it.
 *
 * The Redis keys go after the transaction commits, for the reason {@link deleteGroupRedisKeys}
 * gives: a crash between the two leaves keys whose group is gone, which the orphan sweep collects,
 * where the reverse order would strip a live group's history if the transaction rolled back.
 *
 * @param manager a NON-transactional manager - this opens the transaction itself
 * @param groupIds the groups to end; empty is a no-op
 * @param releaseDistributionScope also clears `distributionWorkspaceId` / `distributionChannelId`.
 *   The scope columns carry a partial unique index that does NOT exclude tombstones, so a retired
 *   distribution group left holding its scope is handed back by the reuse read - turning a salon
 *   public and private again returned the group it had just retired, tombstone and all.
 * @returns how many rows each table gave up, for the caller's log line
 */
export async function tombstoneGroups(
  manager: EntityManager,
  redis: Redis,
  groupIds: string[],
  { releaseDistributionScope = false }: { releaseDistributionScope?: boolean } = {}
): Promise<GroupOwnedRowCounts> {
  if (groupIds.length === 0) return noRowsRemoved();

  const counts = await manager.transaction(async (tx) => {
    await tx.getRepository(Group).update(
      { id: In(groupIds) },
      {
        deletedAt: new Date(),
        ...(releaseDistributionScope
          ? { distributionWorkspaceId: null, distributionChannelId: null }
          : {}),
      }
    );
    // SOFT, always: the tombstone stays, so the per-user dismissal markers stay with it.
    return deleteGroupOwnedRows(tx, groupIds, { groupRowSurvives: true });
  });
  await deleteGroupRedisKeys(redis, groupIds);
  return counts;
}

/**
 * THE REDIS KEYS A GROUP OWNS, as prefixes - the second half of "what a group owns", and the only
 * list of it. {@link deleteGroupRedisKeys} removes them and {@link scanGroupRedisKeyOwners}
 * discovers groups through them, so a shape added here is swept AND discovered.
 *
 * It was two lists, and the shorter one was the sweep's: `cleanupOrphanedRedisGroups` scanned
 * `group:members:*`, and for a group absent from `dm_groups` deleted THAT KEY ALONE - leaving the
 * `history:` stream, and deleting the only key through which that stream was still reachable. The
 * repair destroyed the evidence of the residue it left, so nothing would ever name that group
 * again: no tombstone for the reaper, no membership row for the row sweep, no key for the key
 * sweep. Permanent, silently.
 *
 * `pending_welcome_notify:` is NOT here: it is keyed by USER, not by group.
 */
export const GROUP_REDIS_KEY_PREFIXES = ['history:', 'group:members:', 'pending_welcome:'] as const;

/** Every Redis key the given group owns, one per shape in {@link GROUP_REDIS_KEY_PREFIXES}. */
export function groupRedisKeys(groupId: string): string[] {
  return GROUP_REDIS_KEY_PREFIXES.map((prefix) => `${prefix}${groupId}`);
}

/**
 * Deletes the Redis keys the given groups own, one per shape in
 * {@link GROUP_REDIS_KEY_PREFIXES}.
 *
 * Separate from {@link deleteGroupOwnedRows} because Redis cannot join the SQL transaction, so the
 * caller runs this AFTER the commit. That order is deliberate: a crash between the two leaves keys
 * whose group is gone, which the orphan sweep collects, whereas the reverse
 * order would strip a live group's history if the transaction then rolled back.
 *
 * `mls:addlock:` and `mls:commitlock:` are NOT here: both are written with an `EX` TTL
 * (`ADD_LOCK_TTL_SEC` and 5 s), so they collect themselves and a purge naming them would only
 * pretend to be doing work.
 */
export async function deleteGroupRedisKeys(redis: Redis, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;

  const keys = groupIds.flatMap(groupRedisKeys);

  for (let i = 0; i < keys.length; i += REDIS_DEL_CHUNK) {
    await redis.del(...keys.slice(i, i + REDIS_DEL_CHUNK));
  }
}

/**
 * Every group id that owns at least one Redis key, found by scanning the shapes above.
 *
 * Returns OWNERS, not orphans: whether a group still has a `dm_groups` row is a question for the
 * database, and answering it here would put a second copy of "is this group gone" beside the one in
 * `purgeOrphanGroups`. The caller hands the whole set to that one purge, which keeps the live ones
 * and takes everything the absent ones own.
 *
 * `SCAN` rather than `KEYS`, so a large keyspace is walked without blocking Redis, and a key seen
 * twice across two rounds costs nothing because the result is a set.
 */
export async function scanGroupRedisKeyOwners(redis: Redis): Promise<Set<string>> {
  const owners = new Set<string>();

  for (const prefix of GROUP_REDIS_KEY_PREFIXES) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        REDIS_SCAN_COUNT
      );
      cursor = next;
      for (const key of keys) owners.add(key.slice(prefix.length));
    } while (cursor !== '0');
  }

  return owners;
}
