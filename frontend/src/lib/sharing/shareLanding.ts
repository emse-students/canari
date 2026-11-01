/**
 * Opens the conversation a share was given to, exactly as a tapped notification opens it.
 *
 * ONE ROAD FOR BOTH SHARES: the "Envoyer a..." picker of a share from another app
 * (`IncomingShareHost`) and the share sheet of a post or a reel (`PostShareSheet`) both land here.
 * The pick is published as a deep-link landing (`notifNav.navigate`), so a salon opens under
 * `/communities` and a DM or a group under `/chat`, and the chat page then stages the share in its
 * composer (`incomingShare.takeFor`). See `docs/wiki/frontend/sharing.md`.
 */
import { notifNav } from '$lib/stores/notifNav.svelte';
import { appendLog } from '$lib/utils/sessionLog';

/**
 * Lands on `conversationId` - the conversation ID, never the map key: a DM is keyed by its display
 * name, and a landing names the group id (`resolveConversationKey` crosses that gap on arrival).
 *
 * PUBLISHING THE TARGET IS ALL THIS DOES; the landing effect in `ChatBackgroundService` routes and
 * selects, as for a native notification tap (`hooks.client.ts`). It used to `goto` the target's
 * route as well, and on a phone already on that route the effect won the race: it selected the
 * conversation, then that `goto`'s `beforeNavigate` drained the overlay stack - closing the
 * conversation it had just opened. The share was staged in a composer the member never saw
 * (Mi 9T, 2026-10-27).
 */
export function landShareOn(conversationId: string): void {
  appendLog(`[SHARE] landing on ${conversationId.slice(0, 16)}`);
  notifNav.navigate(conversationId);
}
