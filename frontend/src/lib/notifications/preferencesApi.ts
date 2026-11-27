import { apiFetch } from '$lib/utils/apiFetch';
import { assertAnsweredByApi } from '$lib/utils/apiJson';
import { deliveryUrl } from '$lib/utils/apiUrl';
import { channelService } from '$lib/services/ChannelService';
import { Log } from '$lib/utils/Log';
import { withClientVersionHeader } from '$lib/utils/appVersion';
import type { NotificationCategory } from './categories';
import type { ConversationNotificationLevel } from './conversationLevel';
import {
  parseNotificationPreferences,
  type NotificationPreferencesSnapshot,
} from './preferencesSnapshot';

export type { NotificationPreferencesSnapshot } from './preferencesSnapshot';

const PATH = '/api/mls/notification-preferences';

/** The account's categories and conversation levels, in one read. Throws on any non-2xx answer. */
export async function fetchNotificationPreferences(): Promise<NotificationPreferencesSnapshot> {
  Log.d('notificationPreferences.fetch');
  const res = await apiFetch(`${deliveryUrl()}${PATH}`);
  if (!res.ok) throw new Error(`notification-preferences ${res.status}`);
  return parseNotificationPreferences(await res.json());
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
