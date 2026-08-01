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
 * The map key that displays `id`, or null when this device does not have it.
 *
 * A conversation is keyed by its DISPLAY NAME - the contact for a DM, the group name for a group -
 * while a notification, a call and a deep link all name the MLS GROUP ID. The two are the same
 * string only for a community channel, so every landing decision has to cross that gap, and it
 * crosses it here. Comparing a pending target against `selectedContact` directly compares an id
 * with a key: false for every DM, which is how a landing came to cancel itself the instant it
 * succeeded (see `endLandingUnlessTarget`).
 */
export function resolveConversationKey(
  conversations: SvelteMap<string, Conversation>,
  id: string | null | undefined
): string | null {
  if (!id) return null;
  if (conversations.has(id)) return id;
  for (const [key, convo] of conversations) {
    if (convo.id === id) return key;
  }
  return null;
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
  const key = resolveConversationKey(nav.conversations, id);
  if (key === null) return false;
  // A direct hit means the key IS the id, which is what history was always requested with. Reached
  // through the name fallback, the key is a display name and the group id comes from the entry.
  const groupId = key === id ? id : (nav.conversations.get(key)?.id ?? id);
  nav.selectConversation(key);
  void nav.loadHistoryForConversation(key, groupId, convCtx);
  return true;
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
