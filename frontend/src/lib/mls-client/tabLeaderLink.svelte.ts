/**
 * THE LEADER'S SOCKET, TOLD TO THE FOLLOWER TABS - the truth behind a follower's connection pill.
 *
 * Only the leader tab holds the gateway WebSocket; a follower delegates its commits to it
 * (`tabCommitDelegation.ts`). So "is this tab connected" has exactly one authority for a follower:
 * the leader's socket. The leader publishes it on every change and answers a follower's query; a
 * follower reads the last answer, and reads NOTHING until one comes - no leader answering is a
 * follower that is offline, not one assumed online. Neither `navigator.onLine` nor "I am not the
 * writer" enters into it.
 *
 * Signals only, on the tab-messages channel, stamped with the account (the channel is per browser):
 * the value is one boolean and the leader republishes it on any change, so a lost signal costs the
 * next change or the follower's next query.
 */
import { currentUserId } from '$lib/stores/userState.svelte';
import { getIsTabLeader } from '$lib/mls-client/tabLeader';

const CHANNEL = 'canari-tab-messages';

/** What crosses the channel: the leader's socket state, and a follower asking for it. */
export type TabLeaderLinkEvent =
  | { type: 'leader_link'; connected: boolean; account: string }
  | { type: 'leader_link_query'; account: string };

/** The leader's last published socket state, null while no leader has answered. */
let leaderConnected = $state<boolean | null>(null);
let channel: BroadcastChannel | null = null;
/** The leader's own socket state, kept so a query can be answered. */
let ownConnected = false;

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

/** Whether a follower tab's leader reports an open socket (false until one answers). */
export function leaderSocketConnected(): boolean {
  return leaderConnected === true;
}

/**
 * The leader's socket changed (or a query asked): publishes it. A no-op outside the leader. Called
 * by the session wherever it writes its own socket state.
 */
export function publishLeaderLink(connected: boolean): void {
  ownConnected = connected;
  if (!getIsTabLeader()) return;
  console.debug(`[TAB] leader link published: ${connected ? 'connected' : 'disconnected'}`);
  ensureChannel()?.postMessage({
    type: 'leader_link',
    connected,
    account: currentUserId() ?? '',
  } satisfies TabLeaderLinkEvent);
}

/** Handles one event (exported for tests): the leader answers queries, a follower records answers. */
export function handleLeaderLinkEvent(event: TabLeaderLinkEvent): void {
  if (event.account !== (currentUserId() ?? '')) return;
  if (event.type === 'leader_link_query') {
    if (getIsTabLeader()) publishLeaderLink(ownConnected);
  } else if (event.type === 'leader_link' && !getIsTabLeader()) {
    leaderConnected = event.connected;
  }
}

/**
 * Starts listening and asks the leader for its state, once per document. A tab that is the leader
 * ignores the answers; a follower records them. The query goes out whatever the role, since the
 * election may not have decided yet - only a leader answers it.
 */
export function startLeaderLink(): () => void {
  const ch = ensureChannel();
  if (!ch) return () => {};
  const onMessage = (ev: MessageEvent<TabLeaderLinkEvent>) => {
    const t = ev.data?.type;
    if (t === 'leader_link' || t === 'leader_link_query') handleLeaderLinkEvent(ev.data);
  };
  ch.addEventListener('message', onMessage);
  ch.postMessage({
    type: 'leader_link_query',
    account: currentUserId() ?? '',
  } satisfies TabLeaderLinkEvent);
  return () => ch.removeEventListener('message', onMessage);
}

/** Test seam: back to a document no leader has answered. */
export function resetLeaderLinkForTests(): void {
  leaderConnected = null;
  ownConnected = false;
}
