/**
 * Module-level singleton for post notification state.
 *
 * Shared between the desktop bell dropdown (PostNotificationBell) and the
 * mobile notifications page (/notifications), so both always show the same
 * unread count and list without a second network fetch.
 */
import {
  getPostNotifications,
  markPostNotificationsRead,
  markPostNotificationsReadForPost,
} from '$lib/posts/api';
import type { PostNotification } from '$lib/posts/api';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { pendingDeviceNotices } from '$lib/utils/chat/deviceNotices.svelte';

let notifications = $state<PostNotification[]>([]);
let loading = $state(false);
/** The last load got no answer; reset by the next one that does. */
let unanswered = false;

export const postNotifStore = {
  get notifications(): PostNotification[] {
    return notifications;
  },
  /**
   * Number of unread notifications: the server's, plus the new-device alerts this device raised
   * (`deviceNotices.svelte.ts`) - local entries of the same list, unread until the owner has seen
   * them (owner decision 2026-10-30). Counted here so every badge reads one number.
   */
  get unread(): number {
    return notifications.filter((n) => !n.read).length + pendingDeviceNotices().length;
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
      unanswered = false;
    } catch (e) {
      // Stale data is better than an error screen. A load that got NO ANSWER is the link, which the
      // session already reports: said once per spell, not on every minute's poll while offline. Any
      // other failure is this route's, and is a warning every time.
      if (!isTransportFailure(e)) {
        console.warn('[postNotifStore] load failed, keeping stale data:', e);
      } else if (!unanswered) {
        unanswered = true;
        console.log(`[postNotifStore] no answer (${String(e)}) - stale data kept until one comes`);
      }
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
  /** Marks notifications for one post as read in the backend and locally. */
  async markPostRead(postId: string): Promise<void> {
    try {
      await markPostNotificationsReadForPost(postId);
      notifications = notifications.map((n) => (n.postId === postId ? { ...n, read: true } : n));
    } catch (e) {
      console.warn('[postNotifStore] mark post read failed:', e);
    }
  },
};
