import type { EntityManager } from 'typeorm';
import { Logger } from '@nestjs/common';
import { NotificationPreference } from '../entities/notification-preference.entity';
import {
  GroupMember,
  isGroupNotificationLevel,
  type GroupNotificationLevel,
} from '../entities/group-member.entity';
import { isNotificationCategory, type NotificationCategory } from './push-category';

const logger = new Logger('NotificationPreferences');

/**
 * The categories `userId` has switched off, for the PUSH path. Empty for an account that never set
 * anything.
 *
 * A READ THAT FAILS ANSWERS "DELIVER", AND SAYS SO: dropping a push because a preference could not
 * be read would lose a message the user wanted to a fault they cannot see. This is the answer of an
 * unset account, not a second code path, and the warning is what makes a broken table visible
 * instead of a silent "everything notifies". The settings route reads through
 * {@link readDisabledCategoriesStrict} instead, which throws.
 */
export async function readDisabledCategories(
  manager: EntityManager,
  userId: string
): Promise<ReadonlySet<NotificationCategory>> {
  try {
    return await readDisabledCategoriesStrict(manager, userId);
  } catch (e) {
    logger.warn(`[NOTIF_PREF] read failed for user=${userId}: ${String(e)} - delivering`);
    return new Set();
  }
}

/** The same read, failing loudly: a settings screen must never draw switches that lie. */
export async function readDisabledCategoriesStrict(
  manager: EntityManager,
  userId: string
): Promise<ReadonlySet<NotificationCategory>> {
  const row = await manager.findOne(NotificationPreference, { where: { userId } });
  return new Set((row?.disabledCategories ?? []).filter(isNotificationCategory));
}

/**
 * How loud conversation `groupId` is for `userId`, for the PUSH path: `all` for a member who never
 * chose, and for somebody with no membership row (the push path never decides membership).
 *
 * Same failure rule as {@link readDisabledCategories}, for the same reason: a read that fails answers
 * `all` - the answer of a member who never chose - and says so.
 */
export async function readGroupNotificationLevel(
  manager: EntityManager,
  groupId: string,
  userId: string
): Promise<GroupNotificationLevel> {
  try {
    const row = await manager.findOne(GroupMember, {
      select: { id: true, notifLevel: true },
      where: { groupId, userId },
    });
    return row && isGroupNotificationLevel(row.notifLevel) ? row.notifLevel : 'all';
  } catch (e) {
    logger.warn(
      `[NOTIF_PREF] group level read failed for group=${groupId} user=${userId}: ${String(e)} - delivering as all`
    );
    return 'all';
  }
}

/**
 * Every conversation `userId` has made quieter than `all`, keyed by group id - what a client loads
 * once to gate the notifications it raises ITSELF (a frame received over the socket, no push). An
 * absent group is `all`. Strict: a settings read must never draw a level that lies.
 */
export async function readGroupNotificationLevelsStrict(
  manager: EntityManager,
  userId: string
): Promise<Record<string, Exclude<GroupNotificationLevel, 'all'>>> {
  const rows = await manager.find(GroupMember, {
    select: { id: true, groupId: true, notifLevel: true },
    where: { userId },
  });
  const levels: Record<string, Exclude<GroupNotificationLevel, 'all'>> = {};
  for (const row of rows) {
    if (row.notifLevel === 'mentions' || row.notifLevel === 'none') {
      levels[row.groupId] = row.notifLevel;
    }
  }
  return levels;
}

/**
 * Sets `userId`'s level for `groupId` on their own membership row.
 *
 * @returns false when the caller has no membership row - not a member, so nothing was written and
 *          the caller must refuse rather than report it saved.
 */
export async function writeGroupNotificationLevel(
  manager: EntityManager,
  groupId: string,
  userId: string,
  level: GroupNotificationLevel
): Promise<boolean> {
  const result = await manager.update(GroupMember, { groupId, userId }, { notifLevel: level });
  return (result.affected ?? 0) > 0;
}

/** Replaces the account's disabled set. Unknown ids are the caller's to refuse. */
export async function writeDisabledCategories(
  manager: EntityManager,
  userId: string,
  disabled: readonly NotificationCategory[]
): Promise<void> {
  await manager.upsert(
    NotificationPreference,
    { userId, disabledCategories: [...new Set(disabled)] },
    { conflictPaths: ['userId'] }
  );
}
