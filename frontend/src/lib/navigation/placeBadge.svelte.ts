import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
import { adminQueueCounts } from '$lib/admin/adminQueueCounts.svelte';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { totalUnreadMessages } from '$lib/utils/unreadTotal';

/**
 * Unread count for a place of the bottom bar - what its dot means.
 *
 * Shared by the two bars that draw it: `BottomNav` (web, Android) and the native iOS tab bar
 * (`NativeTabBar`), so a dot cannot light up on one and not the other. The place you are on
 * carries none: you are already looking at what it would announce.
 *
 * `chat` and `communities` each carry the unread messages belonging to that place. Keeping the
 * channel split here means a salon message cannot light up Discussions, while both web and native
 * bars still ask the same question. `dashboard` carries the items waiting in the admin queues the
 * reader can act on (`adminQueueCounts`, owner 2026-11-18): the dashboard is the way to the
 * Administration row, and a member's counts are empty, so it never lights for them.
 */
export function placeBadge(placeId: string, isActive: boolean): number {
  if (isActive || !globalSession.isLoggedIn) return 0;
  if (placeId === 'chat') {
    return totalUnreadMessages(
      globalConvs.conversations.values(),
      (conversation) => !isChannelConversationId(conversation.id ?? '')
    );
  }
  if (placeId === 'communities') {
    return totalUnreadMessages(globalConvs.conversations.values(), (conversation) =>
      isChannelConversationId(conversation.id ?? '')
    );
  }
  if (placeId === 'notifications') return postNotifStore.unread;
  if (placeId === 'dashboard') return adminQueueCounts.total;
  return 0;
}
