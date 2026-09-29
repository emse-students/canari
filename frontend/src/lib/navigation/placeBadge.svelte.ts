import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
import { totalUnreadMessages } from '$lib/utils/unreadTotal';

/**
 * Unread count for a place of the bottom bar - what its dot means.
 *
 * Shared by the two bars that draw it: `BottomNav` (web, Android) and the native iOS tab bar
 * (`NativeTabBar`), so a dot cannot light up on one and not the other. The place you are on
 * carries none: you are already looking at what it would announce.
 *
 * `chat` is the only one of the four bar places that can carry a badge - which is why the web
 * dot's `aria-label` is the unread-MESSAGES sentence. The notifications branch is the rule for a
 * place that is not currently in the bar; giving it a badge there means giving it a sentence too.
 */
export function placeBadge(placeId: string, isActive: boolean): number {
  if (isActive || !globalSession.isLoggedIn) return 0;
  if (placeId === 'chat') return totalUnreadMessages(globalConvs.conversations.values());
  if (placeId === 'notifications') return postNotifStore.unread;
  return 0;
}
