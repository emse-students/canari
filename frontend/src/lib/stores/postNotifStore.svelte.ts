/**
 * Module-level singleton for post notification state.
 *
 * Shared between the desktop bell dropdown (PostNotificationBell) and the
 * mobile notifications page (/notifications), so both always show the same
 * unread count and list without a second network fetch.
 */
import { getPostNotifications, markPostNotificationsRead } from '$lib/posts/api';
import type { PostNotification } from '$lib/posts/api';

let notifications = $state<PostNotification[]>([]);
let loading = $state(false);

export const postNotifStore = {
  get notifications(): PostNotification[] {
    return notifications;
  },
  /** Number of unread notifications. */
  get unread(): number {
    return notifications.filter((n) => !n.read).length;
  },
  get loading(): boolean {
    return loading;
  },
  /** Fetches the latest notifications from the backend and updates the store. */
  async load(limit = 30): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      notifications = await getPostNotifications(limit);
    } catch (e) {
      // stale data is better than an error screen; log for diagnostics
      console.warn('[postNotifStore] load failed, keeping stale data:', e);
    } finally {
      loading = false;
    }
  },
  /** Marks all notifications as read in the backend and locally. */
  async markAllRead(): Promise<void> {
    if (notifications.every((n) => n.read)) return;
    try {
      await markPostNotificationsRead();
      notifications = notifications.map((n) => ({ ...n, read: true }));
    } catch (e) {
      console.warn('[postNotifStore] markAllRead failed:', e);
    }
  },
};
