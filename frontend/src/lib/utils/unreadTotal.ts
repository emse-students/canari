/**
 * The unread total, in one place, because three readers needed the same number.
 *
 * `AppSidebar` and `BottomNav` each carried their own copy of this reduce, and the tab indicator
 * would have been a third. Three spellings of one question is how two of them end up disagreeing
 * about whether a channel counts.
 */

/** The shape this function needs of a conversation, and nothing more. */
export interface HasUnreadCount {
  unreadCount?: number;
}

/**
 * Sums the unread messages of every conversation.
 *
 * `unreadCount` is optional on a freshly created row and absent means zero, never "unknown" - a
 * conversation nobody has counted yet has nothing to announce.
 */
export function totalUnreadMessages(conversations: Iterable<HasUnreadCount>): number {
  let total = 0;
  for (const c of conversations) total += c.unreadCount ?? 0;
  return total;
}
