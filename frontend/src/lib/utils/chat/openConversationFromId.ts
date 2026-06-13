import type { Conversation } from '$lib/types';
import type { ConversationContext } from '$lib/composables/useConversations.svelte';
import type { SvelteMap } from 'svelte/reactivity';

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
