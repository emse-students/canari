import { goto } from '$app/navigation';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { isChannelConversationId } from './channelCrypto';

/**
 * The app route that can display a given chat-notification target. DMs and groups live under
 * `/chat`; community channels (`channel_<uuid>`) live under `/communities`. A channel deep-link
 * opened on `/chat` would land on the wrong view, so notification handling routes by target type.
 */
export function chatDeepLinkRoute(conversationId: string): '/chat' | '/communities' {
  return isChannelConversationId(conversationId) ? '/communities' : '/chat';
}

/**
 * Opens the community channel behind an invitation (the DM card's "Rejoindre la communauté", or an
 * accepted invite link).
 *
 * The target is a channel, so it lives under `/communities`: routing to `/chat` lands on a view
 * that structurally cannot show it, which is what made the button look inert. Selection itself is
 * left to the pending-target effect, which refreshes the sidebar when it does not yet know the
 * channel - a just-accepted invitation is never in the loaded list.
 */
export async function openInvitedChannel(channelId: string): Promise<void> {
  if (!channelId) return;
  const channelConversationId = `channel_${channelId}`;
  notifNav.navigate(channelConversationId);
  await goto(chatDeepLinkRoute(channelConversationId));
}
