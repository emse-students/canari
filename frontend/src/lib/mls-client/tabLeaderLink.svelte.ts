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
import {
  getIsTabLeader,
  getTabLeadership,
  whenTabLeadershipDecided,
} from '$lib/mls-client/tabLeader';

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
/** The teardown of the one running link, `null` before the first start. */
let started: (() => void) | null = null;

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
 * Says where this tab stands, once the two facts that make the message meaningful are known: WHO the
 * account is (every event is stamped with it and a receiver drops another account's) and WHICH side
 * of the election this tab is on. A follower asks the leader; the leader publishes its socket, so a
 * follower whose query it could not answer (its own account was not known yet) still hears it.
 */
function announce(): void {
  const account = currentUserId();
  if (!account || getTabLeadership() === 'undecided') return;
  if (getIsTabLeader()) {
    publishLeaderLink(ownConnected);
    return;
  }
  console.debug('[TAB] leader link asked');
  ensureChannel()?.postMessage({
    type: 'leader_link_query',
    account,
  } satisfies TabLeaderLinkEvent);
}

/**
 * Starts listening, once per document. A tab that is the leader ignores the answers; a follower
 * records them.
 *
 * THE QUERY MUST NOT OUTRUN THE ACCOUNT (a second tab read "Hors-ligne" while the account was
 * online): this ran at module start with `currentUserId() ?? ''`, before the user id was known, and
 * the leader dropped it as another account's - so no answer ever came until its socket changed.
 * {@link announce} now runs when the account becomes known AND when the election is decided, in
 * whichever order those happen.
 */
export function startLeaderLink(): () => void {
  // ONCE PER DOCUMENT: every session creation calls this and discards the teardown, so without the
  // guard each one added an effect and a listener.
  if (started) return started;
  const ch = ensureChannel();
  if (!ch) return () => {};
  const onMessage = (ev: MessageEvent<TabLeaderLinkEvent>) => {
    const t = ev.data?.type;
    if (t === 'leader_link' || t === 'leader_link_query') handleLeaderLinkEvent(ev.data);
  };
  ch.addEventListener('message', onMessage);
  let lastAccount: string | null | undefined;
  const stopEffect = $effect.root(() => {
    $effect(() => {
      const account = currentUserId();
      // A last answer belongs to the account it was given for: never carried to another one.
      if (lastAccount !== undefined && account !== lastAccount) leaderConnected = null;
      lastAccount = account;
      // The role is read inside `announce` once decided.
      if (account) announce();
    });
  });
  void whenTabLeadershipDecided().then(announce);
  started = () => {
    stopEffect();
    ch.removeEventListener('message', onMessage);
    started = null;
  };
  return started;
}

/**
 * This tab's role changed (promotion or demotion): forget the last leader's answer - a follower
 * must never keep a dead leader's "connected" - and say where the tab stands now.
 */
export function leadershipChanged(): void {
  leaderConnected = null;
  announce();
}

/** Test seam: back to a document no leader has answered. */
export function resetLeaderLinkForTests(): void {
  started?.();
  leaderConnected = null;
  ownConnected = false;
}
