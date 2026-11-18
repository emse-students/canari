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
import { unreadDeviceNoticeCount } from '$lib/utils/chat/deviceNotices.svelte';
import {
  BELL_SLOT,
  localCopiesAccess,
  onLocalCopiesOpen,
  readLocalCopy,
  writeLocalCopy,
} from '$lib/localCopies/localCopyStore.svelte';
import type { FeedStoreAccess } from '$lib/posts/feedStore';
import { getSavedUserId } from '$lib/stores/user';
import { onPeerNamesEnded } from '$lib/utils/users/peerNameDirectory';

/** The newest notifications kept on the device: the bell page asks for 50, the dropdown for 30. */
export const MAX_STORED_NOTIFICATIONS = 50;

let notifications = $state<PostNotification[]>([]);
let loading = $state(false);
/** The last load got no answer; reset by the next one that does. */
let unanswered = false;
/**
 * The list on screen is the device's SEALED COPY, not an answer: drawn at once (0 round trips) and
 * replaced by the first answer (slow-link chantier, gap 2).
 */
let fromCopy = $state(false);
/** The account the in-memory list belongs to; a list is never drawn or written under another. */
let listOwner: string | null = null;
/** Whether a server answer has landed in this launch: a copy read after it is never drawn. */
let answered = false;

function isStoredNotification(value: unknown): value is PostNotification {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

/** What was last handed to the sealed store, so an unchanged list is not sealed again. */
let lastSealed: string | null = null;

/**
 * Seals the newest rows (a no-op while no key is in hand, the list is another account's, or it is
 * what was sealed last - the 60 s poll answers the same list almost every time).
 */
function persist(): void {
  if (!listOwner || localCopiesAccess()?.userId !== listOwner) return;
  const items = notifications.slice(0, MAX_STORED_NOTIFICATIONS);
  const json = JSON.stringify(items);
  if (json === lastSealed) return;
  lastSealed = json;
  void writeLocalCopy(BELL_SLOT, { items });
}

/** A sign-out or a change of account: the list leaves memory with the account (never drawn for the next). */
onPeerNamesEnded(() => {
  notifications = [];
  fromCopy = false;
  listOwner = null;
  answered = false;
  lastSealed = null;
});

/**
 * Copies opened (or re-keyed) for `access`: another account's list leaves memory; an empty list is
 * drawn from the stored copy; a list already held (an answer came before the key) is sealed.
 */
async function openFor(access: FeedStoreAccess): Promise<void> {
  if (notifications.length > 0 && listOwner !== access.userId) {
    // Held for another account, or for nobody known: never drawn nor sealed under this one.
    notifications = [];
    fromCopy = false;
  }
  if (listOwner !== access.userId) answered = false;
  if (notifications.length > 0) {
    // The key changed, or the answer beat the key: seal what is held, even if sealed before.
    lastSealed = null;
    persist();
    return;
  }
  const items = await readLocalCopy(access, BELL_SLOT, (body) => {
    const list = (body as { items?: unknown } | null)?.items;
    return Array.isArray(list) && list.every(isStoredNotification)
      ? (list as PostNotification[])
      : null;
  });
  // An answer that landed while the read waited is newer than any copy.
  if (!items || answered || notifications.length > 0) return;
  notifications = items;
  listOwner = access.userId;
  fromCopy = true;
  console.log(`[postNotifStore] ${items.length} notification(s) drawn from the device, no network`);
}
onLocalCopiesOpen((access) => void openFor(access));

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
    return notifications.filter((n) => !n.read).length + unreadDeviceNoticeCount();
  },
  get loading(): boolean {
    return loading;
  },
  /** True while the list on screen is the device's copy, not yet confirmed by the server. */
  get fromCopy(): boolean {
    return fromCopy;
  },
  /** Fetches the latest notifications from the backend and updates the store. */
  async load(limit = 30): Promise<void> {
    if (loading) return;
    loading = true;
    // THE ACCOUNT IS TAKEN BEFORE THE REQUEST, never when the answer lands (review of #3347, as
    // `feedWriteEpoch` does): a poll answered after a sign-out and a sign-in as someone else - no page
    // reload on mobile - is that account's list and must not be drawn or sealed under the new one.
    const owner = getSavedUserId();
    try {
      const answer = await getPostNotifications(limit);
      if (getSavedUserId() !== owner) {
        console.log('[postNotifStore] an answer for an account that has left - dropped');
        return;
      }
      notifications = answer;
      unanswered = false;
      answered = true;
      fromCopy = false;
      listOwner = owner;
      // Only the full page seals: the dropdown's shorter one must not shrink the sealed list.
      if (limit >= MAX_STORED_NOTIFICATIONS) persist();
    } catch (e) {
      // Stale data is better than an error screen. A load that got NO ANSWER is the link, which the
      // session already reports: said once per spell, not on every minute's poll while offline. Any
      // other failure is this route's, and is a warning every time.
      if (!isTransportFailure(e)) {
        console.warn(
          `[postNotifStore] load failed, keeping ${fromCopy ? 'the device copy' : 'stale data'}:`,
          e
        );
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
    // A list still drawn from the device is not what the server holds: the read receipt goes once an
    // answer has replaced it (the bell page awaits `load` first).
    if (fromCopy) {
      console.log('[postNotifStore] markAllRead skipped - the list is still the device copy');
      return;
    }
    const owner = getSavedUserId();
    try {
      await markPostNotificationsRead();
      if (getSavedUserId() !== owner) return; // another account's list now: not marked locally
      notifications = notifications.map((n) => ({ ...n, read: true }));
      persist();
    } catch (e) {
      console.warn('[postNotifStore] markAllRead failed:', e);
    }
  },
  /** Marks notifications for one post as read in the backend and locally. */
  async markPostRead(postId: string): Promise<void> {
    try {
      await markPostNotificationsReadForPost(postId);
      notifications = notifications.map((n) => (n.postId === postId ? { ...n, read: true } : n));
      persist();
    } catch (e) {
      console.warn('[postNotifStore] mark post read failed:', e);
    }
  },
};
