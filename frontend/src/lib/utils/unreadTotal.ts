/**
 * The unread total, in one place, because every navigation reader needs the same reduction.
 *
 * `AppSidebar`, `BottomNav` and the tab indicator share this reduction. An optional predicate lets
 * navigation places answer which conversations belong to them without maintaining a second count.
 */

/** The shape this function needs of a conversation, and nothing more. */
export interface HasUnreadCount {
  id?: string;
  unreadCount?: number;
}

/**
 * Sums the unread messages of every conversation.
 *
 * `unreadCount` is optional on a freshly created row and absent means zero, never "unknown" - a
 * conversation nobody has counted yet has nothing to announce.
 */
export function totalUnreadMessages(
  conversations: Iterable<HasUnreadCount>,
  include: (conversation: HasUnreadCount) => boolean = () => true
): number {
  let total = 0;
  for (const c of conversations) {
    if (include(c)) total += c.unreadCount ?? 0;
  }
  return total;
}
