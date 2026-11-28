/**
 * The account's notification preferences as the server SAYS them, validated: one parser for the read
 * that answers them (`preferencesApi.fetchNotificationPreferences`) and for the device's copy of the
 * last answer (`notificationPreferences`), which is kept in the same wire shape so a copy is never
 * trusted further than an answer.
 */
import { isNotificationCategory, OPT_IN_CATEGORIES, type NotificationCategory } from './categories';
import {
  isConversationNotificationLevel,
  type ConversationNotificationLevel,
} from './conversationLevel';
import { Log } from '$lib/utils/Log';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shape of a category id: what an id this build does not know must look like to be kept. */
const CATEGORY_ID_RE = /^[a-z][a-z_]{0,63}$/;

/** What the account's notification preferences read answers. */
export interface NotificationPreferencesSnapshot {
  /** The categories switched off. */
  disabled: NotificationCategory[];
  /**
   * Switched-off ids THIS BUILD DOES NOT KNOW - a category added after it (a newer server). It draws
   * no switch for them, so it has no choice to make about them: they are kept as read and sent back
   * on every save, so a save from here never switches back on what another device switched off.
   */
  unknownDisabled: string[];
  /** The opt-in categories (`OPT_IN_CATEGORIES`) whose PUSH the account turned on. */
  pushEnabled: NotificationCategory[];
  /** Every private conversation made quieter than `all`, keyed by group id (absent = `all`). */
  groupLevels: Record<string, ConversationNotificationLevel>;
  /**
   * Every private conversation where the account CHOSE whether calls may ring it, keyed by group id.
   * Absent = never chose, resolved against the level by `callsAllowedFor`.
   */
  groupCalls: Record<string, boolean>;
}

/** The wire shape of the read's answer - and of the device's copy of it. */
export interface NotificationPreferencesWire {
  disabled: string[];
  enabled: NotificationCategory[];
  groupLevels: Record<string, ConversationNotificationLevel>;
  groupCalls: Record<string, boolean>;
}

/** A snapshot back in the wire shape, so the device's copy goes through {@link parseNotificationPreferences}. */
export function toNotificationPreferencesWire(
  snapshot: NotificationPreferencesSnapshot
): NotificationPreferencesWire {
  return {
    disabled: [...snapshot.disabled, ...snapshot.unknownDisabled],
    enabled: [...snapshot.pushEnabled],
    groupLevels: { ...snapshot.groupLevels },
    groupCalls: { ...snapshot.groupCalls },
  };
}

/** What {@link parseNotificationPreferences} is reading, as its line names it. */
export type PreferencesOrigin = 'the server answer' | 'the device copy';

/**
 * Validates an answer (or the device's copy of one): an unknown field is ignored, a malformed one
 * reads as empty, never thrown.
 *
 * @param origin - Which of the two it is, so a line about it says so.
 */
export function parseNotificationPreferences(
  raw: unknown,
  origin: PreferencesOrigin
): NotificationPreferencesSnapshot {
  const body = (raw && typeof raw === 'object' ? raw : {}) as {
    disabled?: unknown;
    enabled?: unknown;
    groupLevels?: unknown;
    groupCalls?: unknown;
  };
  const disabledIds: unknown[] = Array.isArray(body.disabled) ? body.disabled : [];
  const disabled = disabledIds.filter(isNotificationCategory);
  const unknownDisabled = disabledIds.filter(
    (id): id is string =>
      typeof id === 'string' && !isNotificationCategory(id) && CATEGORY_ID_RE.test(id)
  );
  if (unknownDisabled.length) {
    Log.d(
      `notificationPreferences: ${origin} keeps ids this build does not know: ${unknownDisabled}`
    );
  }
  const groupLevels: Record<string, ConversationNotificationLevel> = {};
  if (body.groupLevels && typeof body.groupLevels === 'object') {
    for (const [groupId, level] of Object.entries(body.groupLevels)) {
      // Only a uuid becomes a key: a remote string must never name an object property.
      if (GROUP_ID_RE.test(groupId) && isConversationNotificationLevel(level)) {
        groupLevels[groupId] = level;
      }
    }
  }
  // Absent on a server older than migration 032: nobody has chosen anything there yet.
  const groupCalls: Record<string, boolean> = {};
  if (body.groupCalls && typeof body.groupCalls === 'object') {
    for (const [groupId, allowed] of Object.entries(body.groupCalls)) {
      if (GROUP_ID_RE.test(groupId) && typeof allowed === 'boolean') groupCalls[groupId] = allowed;
    }
  }
  const enabledIds: unknown[] = Array.isArray(body.enabled) ? body.enabled : [];
  const pushEnabled = enabledIds
    .filter(isNotificationCategory)
    .filter((c) => OPT_IN_CATEGORIES.includes(c));
  return { disabled, unknownDisabled, pushEnabled, groupLevels, groupCalls };
}

/**
 * Erases the device copies of the notification settings of every account but `keep` - by PREFIX, so
 * a copy goes even when the store never learnt whose it was (a sign-out during a sign-in in flight,
 * or behind the PIN gate after a cold start, where no account was bound). Called by every sign-out
 * (`clearUserLocally`) and by a change of account (`saveUserLocally`). Never throws; a failure is said.
 *
 * @param keep - The account whose copy stays (the one signing in), if any.
 * @returns How many copies were erased.
 */
export function eraseNotificationPreferenceCopies(keep?: string): number {
  const prefix = ACCOUNT_KEY.notificationPreferences('');
  const kept = keep === undefined ? null : ACCOUNT_KEY.notificationPreferences(keep);
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix) && key !== kept) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (e) {
    console.warn('[NOTIF_PREF] the device copies of the settings could not be erased', e);
    return 0;
  }
  if (keys.length > 0) {
    console.log(`[NOTIF_PREF] ${keys.length} device copy(ies) of the settings erased`);
  }
  return keys.length;
}
