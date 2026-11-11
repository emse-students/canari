import type { ConversationOutcome, ConversationRefusal } from './groupCreation';
import { PENDING_CONTACT_KEY } from './selectionAcrossReload';

/**
 * WHAT ANOTHER PAGE ASKS THE CHAT PAGE TO OPEN, NAMED BY ITS KIND.
 *
 * Two pages hand the chat page something to open across a navigation: the posts mini panel and the
 * multi-tab reload name a CONVERSATION (its map key, the MLS group id - `PENDING_CONTACT_KEY`), and a
 * profile's "Message" button names a PERSON. Both used to go through the one key, so the profile's
 * USER id was selected as if it were a map key: no conversation is ever keyed by a user id
 * ([chat](../../../../../docs/wiki/frontend/modules/chat.md#one-key-per-conversation---the-a-dm-has-two-keys-premise-audited-and-refuted-2026-10-04)),
 * the selection watchdog dropped it in the same frame (`[SELECT] ... is not in the conversation map`)
 * and "Message" opened nothing - whether a DM with that person existed or not.
 *
 * A person is therefore its own key, and it is answered by `startNewConversation`, the one path that
 * finds the DM with a peer (local map, then the server's groups) and creates it when there is none.
 *
 * NO CLOCK. The page used to apply the pending selection 600 ms after login, a guess at how long the
 * restore takes; a slower restore found an empty map and the selection was dropped. It is now applied
 * once the map is authoritative - `conversationSourcesSettled`, the gate the notification landing
 * already uses - and read until then, never consumed early.
 */

/** The sessionStorage key a profile's "Message" button writes: the PEER's user id. */
export const PENDING_DIRECT_PEER_KEY = 'canari_pending_direct_peer';

/** What the chat page was asked to open. */
export type PendingChatOpening =
  | { kind: 'conversation'; key: string }
  | { kind: 'direct'; peerUserId: string };

/** The storage the opening travels through - `sessionStorage` in the app, a fake in the tests. */
export type OpeningStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Asks the chat page to open the direct conversation with `peerUserId`, existing or new. Written by
 * a page that is about to navigate to `/chat`.
 */
export function requestDirectConversationWith(peerUserId: string, storage: OpeningStorage): void {
  storage.setItem(PENDING_DIRECT_PEER_KEY, peerUserId);
}

/**
 * Reads AND removes what the chat page was asked to open. A person wins over a conversation: the
 * person was asked by the reader's own tap on a profile, which is necessarily the later of the two.
 */
export function takePendingChatOpening(storage: OpeningStorage): PendingChatOpening | null {
  const peerUserId = storage.getItem(PENDING_DIRECT_PEER_KEY);
  const key = storage.getItem(PENDING_CONTACT_KEY);
  storage.removeItem(PENDING_DIRECT_PEER_KEY);
  storage.removeItem(PENDING_CONTACT_KEY);
  if (peerUserId) return { kind: 'direct', peerUserId };
  if (key) return { kind: 'conversation', key };
  return null;
}

/** What {@link landPendingChatOpening} needs from the chat page. */
export interface PendingChatOpeningDeps {
  storage: OpeningStorage;
  /** True once every pass that can add a conversation has run: the map is authoritative. */
  sourcesSettled: () => boolean;
  /** Whether the map holds this key. */
  hasConversation: (key: string) => boolean;
  selectConversation: (key: string) => void;
  /** Finds or creates the DM with a peer, and selects it (`useConversations.startNewConversation`). */
  startDirectConversation: (peerUserId: string) => Promise<ConversationOutcome>;
  /** Tells the reader why the DM could not be opened (`conversationRefusalMessage`, a toast). */
  onRefused: (reason: ConversationRefusal) => void;
  log: (message: string) => void;
}

/**
 * Opens what another page asked for, once the conversation map is authoritative.
 *
 * Before then it does nothing and CONSUMES nothing, so the caller re-runs it when the map settles.
 *
 * @returns what was opened, `null` when nothing was pending or the map is not settled yet.
 */
export async function landPendingChatOpening(
  deps: PendingChatOpeningDeps
): Promise<PendingChatOpening | null> {
  if (!deps.sourcesSettled()) return null;
  const opening = takePendingChatOpening(deps.storage);
  if (!opening) return null;
  if (opening.kind === 'conversation') {
    if (!deps.hasConversation(opening.key)) {
      // Said rather than selected: the watchdog would drop the key in the same frame anyway.
      console.warn(
        `[OPEN] asked to open ${opening.key.slice(0, 8)}... which this device does not hold - nothing opens`
      );
      return opening;
    }
    deps.log(`[OPEN] opening the asked conversation ${opening.key.slice(0, 8)}...`);
    deps.selectConversation(opening.key);
    return opening;
  }
  deps.log(`[OPEN] opening the DM with the asked person ${opening.peerUserId.slice(0, 8)}...`);
  const outcome = await deps.startDirectConversation(opening.peerUserId);
  if (outcome.ok) {
    deps.log(
      outcome.key
        ? `[OPEN] DM with ${opening.peerUserId.slice(0, 8)}... opened as ${outcome.key.slice(0, 8)}...`
        : `[OPEN] DM with ${opening.peerUserId.slice(0, 8)}...: nothing to open (own account)`
    );
  } else {
    console.warn(
      `[OPEN] DM with ${opening.peerUserId.slice(0, 8)}... could not be opened: ${outcome.reason}`
    );
    deps.onRefused(outcome.reason);
  }
  return opening;
}
