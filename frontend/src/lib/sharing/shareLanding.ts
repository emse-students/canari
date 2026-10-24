/**
 * Opens the conversation a share was given to, exactly as a tapped notification opens it.
 *
 * ONE ROAD FOR BOTH SHARES: the "Envoyer a..." picker of a share from another app
 * (`IncomingShareHost`) and the share sheet of a post or a reel (`PostShareSheet`) both land here.
 * The pick is published as a deep-link landing (`notifNav.navigate`), so a salon opens under
 * `/communities` and a DM or a group under `/chat`, and the chat page then stages the share in its
 * composer (`incomingShare.takeFor`). See `docs/wiki/frontend/sharing.md`.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { chatDeepLinkRoute } from '$lib/utils/chat/notificationRouting';

/**
 * Lands on `conversationId` - the conversation ID, never the map key: a DM is keyed by its display
 * name, and a landing names the group id (`resolveConversationKey` crosses that gap on arrival).
 */
export function landShareOn(conversationId: string): void {
  notifNav.navigate(conversationId);
  void goto(resolve(chatDeepLinkRoute(conversationId)));
}
