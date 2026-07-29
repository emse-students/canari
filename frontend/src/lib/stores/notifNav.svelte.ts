/**
 * notifNav - the deep-link target currently being landed.
 *
 * Every deep link publishes its target here and navigates: a tapped notification
 * (`hooks.client.ts`, `useNotifications`), the DM invite card's Join button and an accepted invite
 * link (both via `openInvitedChannel`). `ChatBackgroundService` owns the landing and selects it.
 *
 * The target stays pending until it is actually DISPLAYED, not until it has been selected once.
 * Selecting once is not enough: the conversations map is rebuilt from scratch by the IndexedDB
 * restore and pruned by every community refetch, so a target selected while it is still filling
 * gets dropped moments later - which is what made every deep link land in the right tab but on
 * nothing. Holding it lets the landing re-assert itself, and lets the selection watchdog in
 * `useConversations` tell a target that is still arriving from one that is genuinely gone.
 *
 * It is released when the user picks another conversation, leaves the target's route, or the
 * landing is abandoned (channel revoked, unknown conversation once the map has settled).
 */

let pendingConvoId = $state<string | null>(null);

export const notifNav = {
  get pending(): string | null {
    return pendingConvoId;
  },
  /** Publishes the target to land on. Callers navigate to `chatDeepLinkRoute(id)` right after. */
  navigate(id: string) {
    pendingConvoId = id;
  },
  /** Ends the landing: displayed and moved on, or abandoned. */
  clear() {
    pendingConvoId = null;
  },
};
