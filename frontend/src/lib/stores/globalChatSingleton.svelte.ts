/**
 * Module-level singletons for the chat session.
 *
 * These are created once at module load time and persist for the entire
 * application lifecycle - across all route navigations. This allows the
 * WebSocket connection, MLS state, and conversation data to remain active
 * even when the user is not on the /chat page.
 *
 * Usage:
 *   import { globalSession, globalConvs, globalMessaging, globalChannels, globalNotifs, appendLog } from '$lib/stores/globalChatSingleton.svelte';
 */
import { useChatSession } from '$lib/composables/useChatSession.svelte';
import { useConversations } from '$lib/composables/useConversations.svelte';
import { useMessaging } from '$lib/composables/useMessaging.svelte';
import { useChannelWorkspaces } from '$lib/composables/useChannelWorkspaces.svelte';
import { useNotifications } from '$lib/composables/useNotifications.svelte';
import { currentUserId } from '$lib/stores/userState.svelte';
import { appendLog } from '$lib/utils/sessionLog';

// ── Singleton composable instances ───────────────────────────────────────────
// Called once at module level - the $state / $derived variables inside live
// for the entire app lifetime (SPA mode, no SSR).
export const globalSession = useChatSession();
export const globalConvs = useConversations();
export const globalMessaging = useMessaging();
export const globalChannels = useChannelWorkspaces();
export const globalNotifs = useNotifications();

// LEAVING A THREAD ENDS THE SALON SELECTION, whichever exit is taken (the in-app back, Android's
// Back, the iOS edge swipe): otherwise the salon row stays highlighted (`aria-current`) after a Back.
globalConvs.onThreadLeft(() => {
  globalChannels.selectedChannelConversationId = '';
});

// THE RAIL BEFORE THE NETWORK (F1, community-open-budget): the account saved on this device gets
// its last community list in memory now, at module load, before the session, MLS or any request.
// Synchronous - one localStorage read - so the Communities tab's first frame can already hold it.
globalChannels.hydrateFromSnapshot(currentUserId(), appendLog);

export { appendLog };
