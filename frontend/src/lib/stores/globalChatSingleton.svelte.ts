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

/**
 * Logs a session entry to the browser/device console. On Tauri, `attachConsole` in the layout
 * forwards these to adb logcat.
 *
 * **IT NO LONGER STAMPS THE LINE, AND THAT IS THE FIX RATHER THAN A LOSS.** It used to prepend
 * `new Date().toLocaleTimeString()` - a SECOND-resolution clock, on a project whose cold-start
 * target is under one second, and only on the lines that happened to come through here. Every other
 * console line in the app carried no time at all, so the two could not be placed against each
 * other. `installConsoleIdTruncation` now stamps all of them, in milliseconds, from the earliest
 * client seam there is; see {@link installConsoleIdTruncation} for why there are two clocks in it.
 *
 * What survives here is the NAME: a line that goes through `appendLog` is part of the session
 * narrative a person reads, as opposed to a `Log.d` debug line. Nothing enforces that distinction,
 * so it is a convention and this docblock is where it is written down.
 */
export function appendLog(msg: string): void {
  console.log(msg);
}
