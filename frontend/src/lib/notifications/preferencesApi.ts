import { apiFetch } from '$lib/utils/apiFetch';
import { assertAnsweredByApi } from '$lib/utils/apiJson';
import { deliveryUrl } from '$lib/utils/apiUrl';
import { channelService } from '$lib/services/ChannelService';
import { Log } from '$lib/utils/Log';
import { withClientVersionHeader } from '$lib/utils/appVersion';
import { isNotificationCategory, OPT_IN_CATEGORIES, type NotificationCategory } from './categories';
import {
  isConversationNotificationLevel,
  type ConversationNotificationLevel,
} from './conversationLevel';

const PATH = '/api/mls/notification-preferences';
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

/** The account's categories and conversation levels, in one read. Throws on any non-2xx answer. */
export async function fetchNotificationPreferences(): Promise<NotificationPreferencesSnapshot> {
  Log.d('notificationPreferences.fetch');
  const res = await apiFetch(`${deliveryUrl()}${PATH}`);
  if (!res.ok) throw new Error(`notification-preferences ${res.status}`);
  const body = (await res.json()) as {
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
    Log.d(`notificationPreferences.fetch keeps ids this build does not know: ${unknownDisabled}`);
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
 * Records whether calls in ONE private conversation may ring this account. Throws on any non-2xx
 * answer (403: not a member), and `NotFromApiError` on a 2xx that is not the API's JSON: a portal's
 * `200` saved nothing, and the change must not read as kept until the next reload undoes it.
 */
export async function saveGroupCallsAllowed(groupId: string, allowed: boolean): Promise<void> {
  Log.d(`notificationPreferences.saveGroupCalls(${groupId}, ${allowed})`);
  const res = await apiFetch(
    `${deliveryUrl()}/api/mls/groups/${encodeURIComponent(groupId)}/calls`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed }),
    }
  );
  if (!res.ok) throw new Error(`group calls ${res.status}`);
  assertAnsweredByApi(res, 'PATCH /api/mls/groups/calls');
}

/**
 * Sets this account's level for ONE private conversation - the salon's `setNotificationLevel` for an
 * MLS group or DM. Throws on any non-2xx answer (403: not a member), and `NotFromApiError` on a 2xx
 * that is not the API's JSON.
 */
export async function saveGroupNotificationLevel(
  groupId: string,
  level: ConversationNotificationLevel
): Promise<void> {
  Log.d(`notificationPreferences.saveGroupLevel(${groupId}, ${level})`);
  const res = await apiFetch(
    `${deliveryUrl()}/api/mls/groups/${encodeURIComponent(groupId)}/notification-level`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    }
  );
  if (!res.ok) throw new Error(`group notification-level ${res.status}`);
  assertAnsweredByApi(res, 'PATCH /api/mls/groups/notification-level');
}

/**
 * Replaces the account's disabled set on the server, which applies it before every push. The ids
 * this build does not know (`unknownDisabled`, as read) go back unchanged, and the request NAMES THIS
 * BUILD (`X-Canari-Client-Version`): the server keeps the stored choice of any category the build
 * cannot name, so neither side alone has to be right. `pushEnabled` (the opt-in categories whose
 * push is on) is ALWAYS sent: its presence is how this build declares it knows the opt-in reading -
 * the server never lets a save without it turn a push on. Throws on any non-2xx answer, and
 * `NotFromApiError` on a 2xx that is not the API's JSON.
 */
export async function saveDisabledCategories(
  disabled: readonly NotificationCategory[],
  unknownDisabled: readonly string[] = [],
  pushEnabled: readonly NotificationCategory[] = []
): Promise<void> {
  Log.d('notificationPreferences.save', { disabled, unknownDisabled, pushEnabled });
  const res = await apiFetch(`${deliveryUrl()}${PATH}`, {
    method: 'PUT',
    headers: withClientVersionHeader({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      disabled: [...disabled, ...unknownDisabled],
      enabled: [...pushEnabled],
    }),
  });
  if (!res.ok) throw new Error(`notification-preferences ${res.status}`);
  assertAnsweredByApi(res, `PUT ${PATH}`);
}

/** This account's level for ONE salon - the social service owns it, so it is read apart from the groups'. */
export function fetchChannelNotificationLevel(
  channelId: string
): Promise<ConversationNotificationLevel> {
  Log.d(`notificationPreferences.fetchChannelLevel(${channelId})`);
  return channelService.getNotificationLevel(channelId);
}
