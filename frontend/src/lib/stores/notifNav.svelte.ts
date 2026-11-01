/**
 * notifNav - the deep-link target currently being landed.
 *
 * Every deep link publishes its target here: a tapped notification (`hooks.client.ts`,
 * `useNotifications`), a share's picked conversation (`landShareOn`), the DM invite card's Join
 * button and an accepted invite link (both via `openInvitedChannel`). `ChatBackgroundService` owns
 * the landing: it ROUTES to the target's view and selects it. Publishing is enough - a caller that
 * also navigates to the route already shown drains, in that navigation's `beforeNavigate`, the
 * overlay the landing has just opened (2026-10-27). `openInvitedChannel` still navigates, because
 * it always changes route (`/chat` to `/communities`) and the overlay it drains is the one left.
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
/**
 * Identity of the CURRENT landing: bumped by every `navigate`, never reset. Two taps on the same
 * conversation publish the same id, so the id cannot tell the landing the app already routed for
 * from a new one - this counter can, and it is what the landing's route-once guard compares.
 */
let landingSeq = $state(0);
/** The landing whose target route has been reached (`landingStep` answered `select`), 0 for none. */
let arrivedSeq = $state(0);

export const notifNav = {
  get pending(): string | null {
    return pendingConvoId;
  },
  /** Identity of the current landing; a repeat tap on the same target is a NEW landing. */
  get landing(): number {
    return landingSeq;
  },
  /**
   * Publishes the target to land on. That is all a caller does: the landing effect routes, and a
   * caller's own navigation to the route already shown would drain the overlay the landing opens.
   */
  navigate(id: string) {
    landingSeq += 1;
    pendingConvoId = id;
  },
  /**
   * True while a landing is pending AND has not yet reached the route that displays its target.
   *
   * NOT the same as `pending !== null`: the target stays pending after arrival, for as long as it
   * is on screen and beyond (on a wide screen nothing releases it when the reader leaves `/chat`).
   * A page that only defers work for a landing on its way somewhere else asks THIS, or it waits
   * for a release that may never come.
   */
  get enRoute(): boolean {
    return pendingConvoId !== null && arrivedSeq !== landingSeq;
  },
  /** Records that the CURRENT landing has reached its target's route. */
  markArrived() {
    arrivedSeq = landingSeq;
  },
  /** Ends the landing: displayed and moved on, or abandoned. */
  clear() {
    pendingConvoId = null;
  },
};
