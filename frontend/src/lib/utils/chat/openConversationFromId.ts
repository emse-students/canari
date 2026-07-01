import type { Conversation } from '$lib/types';
import type { ConversationContext } from '$lib/composables/useConversations.svelte';
import type { SvelteMap } from 'svelte/reactivity';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';

/** Minimal conversation store surface for notification / call deep-link navigation. */
export interface ConversationNavigator {
  conversations: SvelteMap<string, Conversation>;
  selectConversation: (name: string) => void;
  loadHistoryForConversation: (
    contactName: string,
    groupId: string,
    ctx: ConversationContext
  ) => Promise<void>;
}

/**
 * Opens a conversation by map key or MLS group id.
 * Returns true when a matching conversation was found and selected.
 */
export function openConversationFromId(
  nav: ConversationNavigator,
  convCtx: ConversationContext,
  id: string
): boolean {
  if (nav.conversations.has(id)) {
    nav.selectConversation(id);
    void nav.loadHistoryForConversation(id, id, convCtx);
    return true;
  }

  for (const [key, convo] of nav.conversations) {
    if (convo.id === id) {
      nav.selectConversation(key);
      void nav.loadHistoryForConversation(key, convo.id, convCtx);
      return true;
    }
  }

  return false;
}

/**
 * Opens a notification-tap target, handling both DMs/groups and community channels. For a channel
 * target (`channel_<uuid>`) it also publishes the id to `setSelectedChannel` so the communities
 * sidebar reveals the right community and the members panel loads - `selectConversation` alone
 * does not drive that channel-specific UI state. Returns false (without side effects) when the
 * channel conversation is not loaded yet, so callers can retry once it appears.
 */
export function openNotificationTarget(
  nav: ConversationNavigator,
  convCtx: ConversationContext,
  id: string,
  setSelectedChannel?: (channelConversationId: string) => void
): boolean {
  if (isChannelConversationId(id)) {
    if (!nav.conversations.has(id)) return false;
    setSelectedChannel?.(id);
    nav.selectConversation(id);
    void nav.loadHistoryForConversation(id, id, convCtx);
    return true;
  }
  return openConversationFromId(nav, convCtx, id);
}
