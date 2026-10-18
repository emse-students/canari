import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';
import { channelService } from '$lib/services/ChannelService';
import { Log } from '$lib/utils/Log';
import { isNotificationCategory, type NotificationCategory } from './categories';
import {
  isConversationNotificationLevel,
  type ConversationNotificationLevel,
} from './conversationLevel';

const PATH = '/api/mls/notification-preferences';
const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the account's notification preferences read answers. */
export interface NotificationPreferencesSnapshot {
  /** The categories switched off. */
  disabled: NotificationCategory[];
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
    groupLevels?: unknown;
    groupCalls?: unknown;
  };
  const disabled = Array.isArray(body.disabled) ? body.disabled.filter(isNotificationCategory) : [];
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
  return { disabled, groupLevels, groupCalls };
}

/**
 * Records whether calls in ONE private conversation may ring this account. Throws on any non-2xx
 * answer (403: not a member).
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
}

/**
 * Sets this account's level for ONE private conversation - the salon's `setNotificationLevel` for an
 * MLS group or DM. Throws on any non-2xx answer (403: not a member).
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
}

/** Replaces the account's disabled set on the server, which applies it before every push. */
export async function saveDisabledCategories(
  disabled: readonly NotificationCategory[]
): Promise<void> {
  Log.d('notificationPreferences.save', disabled);
  const res = await apiFetch(`${deliveryUrl()}${PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  if (!res.ok) throw new Error(`notification-preferences ${res.status}`);
}

/** This account's level for ONE salon - the social service owns it, so it is read apart from the groups'. */
export function fetchChannelNotificationLevel(
  channelId: string
): Promise<ConversationNotificationLevel> {
  Log.d(`notificationPreferences.fetchChannelLevel(${channelId})`);
  return channelService.getNotificationLevel(channelId);
}
