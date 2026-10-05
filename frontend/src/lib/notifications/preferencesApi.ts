import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { isNotificationCategory, type NotificationCategory } from './categories';

const PATH = '/api/mls/notification-preferences';

/** The categories the signed-in account has switched off. Throws on any non-2xx answer. */
export async function fetchDisabledCategories(): Promise<NotificationCategory[]> {
  Log.d('notificationPreferences.fetch');
  const res = await apiFetch(`${deliveryUrl()}${PATH}`);
  if (!res.ok) throw new Error(`notification-preferences ${res.status}`);
  const body = (await res.json()) as { disabled?: unknown };
  return Array.isArray(body.disabled) ? body.disabled.filter(isNotificationCategory) : [];
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
