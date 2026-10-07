import type { EntityManager } from 'typeorm';
import { Logger } from '@nestjs/common';
import { NotificationPreference } from '../entities/notification-preference.entity';
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
