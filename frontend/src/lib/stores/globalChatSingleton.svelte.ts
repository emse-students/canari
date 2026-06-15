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

// ── Singleton composable instances ───────────────────────────────────────────
// Called once at module level - the $state / $derived variables inside live
// for the entire app lifetime (SPA mode, no SSR).
export const globalSession = useChatSession();
export const globalConvs = useConversations();
export const globalMessaging = useMessaging();
export const globalChannels = useChannelWorkspaces();
export const globalNotifs = useNotifications();

/** Logs a timestamped entry to the browser/device console. On Tauri, `attachConsole` in the layout forwards these to adb logcat. */
export function appendLog(msg: string): void {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
