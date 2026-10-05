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

/**
 * The unread count of one salon, as the salon row and the community rail BOTH read it.
 *
 * The live conversation owns the count (`useMessaging` bumps and zeroes it); the workspace row's own
 * `unreadCount` is only what a listing carried before the conversation existed. One function, so the
 * rail's dot and the row's badge cannot disagree about the same salon.
 */
export function channelUnreadCount(
  channel: HasUnreadCount & { id: string },
  conversations: { get(id: string): HasUnreadCount | undefined }
): number {
  return conversations.get(channel.id)?.unreadCount ?? channel.unreadCount ?? 0;
}

/**
 * True when ANY salon of a community has something to read - what the rail's dot means.
 *
 * Derived from the per-salon count, never stored: a second ledger would be one more thing to clear.
 * There is no mute filter because none exists on this side - a salon's notification level is a
 * server-held PUSH preference that the salon rows' own badges ignore too, so the dot agrees with
 * the badges it summarises.
 */
export function communityHasUnread(
  channels: readonly (HasUnreadCount & { id: string })[],
  conversations: { get(id: string): HasUnreadCount | undefined }
): boolean {
  return channels.some((channel) => channelUnreadCount(channel, conversations) > 0);
}
