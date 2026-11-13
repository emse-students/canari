import type { EntityManager } from 'typeorm';
import { Logger } from '@nestjs/common';
import { NotificationPreference } from '../entities/notification-preference.entity';
import {
  GroupMember,
  isGroupNotificationLevel,
  type GroupNotificationLevel,
  type GroupUuid,
} from '../entities/group-member.entity';
import { cutUserId } from '../utils/log-repeat';
import {
  effectiveDisabledCategories,
  isOptInCategory,
  OPT_IN_CATEGORIES,
  storedSwitches,
  type NotificationCategory,
  type StoredSwitches,
} from './push-category';

const logger = new Logger('NotificationPreferences');

/**
 * The categories off for `userId`, for the PUSH path: for an account that never set anything, the
 * opt-in categories only (`OPT_IN_CATEGORIES`, off until turned on).
 *
 * A READ THAT FAILS ANSWERS AS AN UNSET ACCOUNT, AND SAYS SO: dropping a push because a preference
 * could not be read would lose a message the user wanted to a fault they cannot see, so every
 * default-on category delivers - and the opt-in ones stay off, which is what that account would get.
 * Not a second code path, and the warning is what makes a broken table visible. The settings route
 * reads through {@link readDisabledCategoriesStrict} instead, which throws.
 */
export async function readDisabledCategories(
  manager: EntityManager,
  userId: string
): Promise<ReadonlySet<NotificationCategory>> {
  try {
    return await readDisabledCategoriesStrict(manager, userId);
  } catch (e) {
    logger.warn(
      `[NOTIF_PREF] read failed for user=${userId}: ${String(e)} - delivering as an unset account (opt-in categories off)`
    );
    return new Set(OPT_IN_CATEGORIES);
  }
}

/** The same read, failing loudly. */
export async function readDisabledCategoriesStrict(
  manager: EntityManager,
  userId: string
): Promise<ReadonlySet<NotificationCategory>> {
  const row = await manager.findOne(NotificationPreference, { where: { userId } });
  return new Set(effectiveDisabledCategories(row));
}

/**
 * The account's two switch sets AS STORED, for the settings screen - failing loudly: a screen must
 * never draw switches that lie. `disabled` is what a build up to 1.6.10-alpha.1 reads as its whole
 * answer, so it never carries the push-only reading of an opt-in category: such a build would save
 * it back as "off in the app too".
 */
export async function readSwitchesStrict(
  manager: EntityManager,
  userId: string
): Promise<StoredSwitches> {
  const row = await manager.findOne(NotificationPreference, { where: { userId } });
  return storedSwitches(row);
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
  groupId: GroupUuid,
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
      `[NOTIF_PREF] group level read failed for group=${groupId} user=${cutUserId(userId)}: ${String(e)} - delivering as all`
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
  groupId: GroupUuid,
  userId: string,
  level: GroupNotificationLevel
): Promise<boolean> {
  const result = await manager.update(GroupMember, { groupId, userId }, { notifLevel: level });
  return (result.affected ?? 0) > 0;
}

/**
 * Every conversation where `userId` CHOSE whether calls may ring them, keyed by group id - the
 * explicit choices only. An absent group never chose, and the client resolves it against its level
 * with the same rule as the server (`callsAllowedFor`), so a level changed later still moves it.
 * Strict, like the levels' read.
 */
export async function readGroupCallPermissionsStrict(
  manager: EntityManager,
  userId: string
): Promise<Record<string, boolean>> {
  const rows = await manager.find(GroupMember, {
    select: { id: true, groupId: true, callsAllowed: true },
    where: { userId },
  });
  const calls: Record<string, boolean> = {};
  for (const row of rows) {
    if (typeof row.callsAllowed === 'boolean') calls[row.groupId] = row.callsAllowed;
  }
  return calls;
}

/**
 * Records `userId`'s choice of whether calls in `groupId` may ring them, on their own membership row.
 *
 * @returns false when the caller has no membership row - nothing was written.
 */
export async function writeGroupCallsAllowed(
  manager: EntityManager,
  groupId: GroupUuid,
  userId: string,
  allowed: boolean
): Promise<boolean> {
  const result = await manager.update(GroupMember, { groupId, userId }, { callsAllowed: allowed });
  return (result.affected ?? 0) > 0;
}

/**
 * Replaces the account's switches WITH WHAT THE CALLER CAN NAME, and KEEPS the stored choice for
 * every category in `keep` - the ones the caller's build draws no switch for (`categoriesNameableBy`):
 * a `1.6.9` phone saving its switches must not decide "Suggestions", a choice it never showed.
 *
 * `disabled` is what the caller draws OFF (for an opt-in category: off in the app too).
 * `pushEnabled` is the opt-in categories whose PUSH the caller turned on - given ONLY by a build that
 * declares it knows the opt-in reading (the PUT's `enabled` field). `undefined` (an older save,
 * 1.6.10-alpha.1 included) leaves `"enabledCategories"` exactly as stored: a save that never drew
 * the push switch can never turn a push on.
 *
 * ONE statement (`INSERT ... ON CONFLICT DO UPDATE`), so two saves at once each merge against the row
 * the other committed - never a read, then a write over a newer row. Unknown ids are the caller's to
 * refuse. Answers the two sets as now stored.
 */
export async function writeDisabledCategories(
  manager: EntityManager,
  userId: string,
  disabled: readonly NotificationCategory[],
  keep: readonly NotificationCategory[] = [],
  pushEnabled?: readonly NotificationCategory[]
): Promise<StoredSwitches> {
  const declared = pushEnabled !== undefined;
  const enabled = OPT_IN_CATEGORIES.filter(
    (category) => declared && !keep.includes(category) && pushEnabled.includes(category)
  );
  const rows = (await manager.query(
    `INSERT INTO notification_preference ("userId", "disabledCategories", "enabledCategories", "updatedAt")
     VALUES ($1, $2::jsonb, $4::jsonb, now())
     ON CONFLICT ("userId") DO UPDATE SET
       "disabledCategories" = (
         SELECT COALESCE(jsonb_agg(c ORDER BY c), '[]'::jsonb) FROM (
           SELECT jsonb_array_elements_text(EXCLUDED."disabledCategories") AS c
           UNION
           SELECT c FROM jsonb_array_elements_text(notification_preference."disabledCategories") c
            WHERE c = ANY($3::text[])
         ) merged
       ),
       "enabledCategories" = CASE WHEN $5::boolean THEN (
         SELECT COALESCE(jsonb_agg(c ORDER BY c), '[]'::jsonb) FROM (
           SELECT jsonb_array_elements_text(EXCLUDED."enabledCategories") AS c
           UNION
           SELECT c FROM jsonb_array_elements_text(notification_preference."enabledCategories") c
            WHERE c = ANY($3::text[])
         ) merged
       ) ELSE notification_preference."enabledCategories" END,
       "updatedAt" = now()
     RETURNING "disabledCategories" AS disabled, "enabledCategories" AS enabled`,
    // Sorted here as the merge sorts, so the stored order never depends on which path wrote it.
    [
      userId,
      JSON.stringify([...new Set(disabled)].sort()),
      [...new Set(keep)],
      JSON.stringify([...enabled].sort()),
      declared,
    ]
  )) as Array<{ disabled: unknown; enabled: unknown }>;
  const stored = storedSwitches({
    disabledCategories: rows[0]?.disabled,
    enabledCategories: rows[0]?.enabled,
  });
  logger.debug(
    `[NOTIF_PREF] user=${cutUserId(userId)} push on=[${stored.enabled.join(',')}]` +
      (declared ? '' : ' (push untouched: the save did not declare the opt-in reading)') +
      (keep.some(isOptInCategory) ? ' (some kept unnamed)' : '')
  );
  return stored;
}
