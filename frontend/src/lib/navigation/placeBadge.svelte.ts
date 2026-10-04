import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
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
 * bars still ask the same question.
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
  return 0;
}
