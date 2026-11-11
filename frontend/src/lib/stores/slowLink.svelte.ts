import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { leaderSocketConnected } from '$lib/mls-client/tabLeaderLink.svelte';

/**
 * The ONE connection indicator, drawn as a ring around the header avatar (owner, 2026-11-11):
 * - `connected` (green): nothing is wrong;
 * - `slow` (amber): answers are arriving, slowly (`connectivity.slow`, derived from observed
 *   latency, never a guess);
 * - `offline` (grey): the transport reaches nothing (`connectivity.isOffline`);
 * - `reconnecting` (grey too): the link is back but an offline unlock is not promoted yet.
 * A leader tab's own dropped socket does NOT move the ring: the reconnect ladder owns it and has no
 * last rung (`scheduleReconnectImpl`), so there is no durable "gave up" fact to show; the ring is
 * green independently of that socket (a limit, written on the wiki). A follower tab with no leader
 * socket is grey.
 * `null` for a logged-out visitor, who has no avatar and no connection to show.
 */
export type ConnectionState = 'connected' | 'slow' | 'offline' | 'reconnecting';

/** Pure derivation, exported for the tests; {@link connection} feeds it the live stores. */
export function deriveConnectionState(input: {
  isLoggedIn: boolean;
  isOffline: boolean;
  isOfflineSession: boolean;
  /**
   * A FOLLOWER tab whose leader publishes no open socket. A follower has no socket of its own, so
   * this is the one durable socket fact the code holds (`isHeaderConnected`'s old second half).
   */
  followerWithoutLeaderSocket: boolean;
  slow: boolean;
}): ConnectionState | null {
  if (!input.isLoggedIn) return null;
  if (input.isOffline) return 'offline';
  if (input.isOfflineSession || input.followerWithoutLeaderSocket) return 'reconnecting';
  return input.slow ? 'slow' : 'connected';
}

/**
 * ONE derivation shared by the two headers (phone and desktop) and the screen-reader announcer, so
 * they cannot disagree. It replaced the "Hors connexion" banner and the "Connecte" pill, which drew
 * the same facts and moved the page.
 */
export const connection = {
  get state(): ConnectionState | null {
    return deriveConnectionState({
      isLoggedIn: session.isLoggedIn,
      isOffline: connectivity.isOffline,
      isOfflineSession: session.isOfflineSession,
      followerWithoutLeaderSocket: !session.isTabLeader && !leaderSocketConnected(),
      slow: connectivity.slow,
    });
  },
};

/**
 * The ring's colour class for a state, written out per state because Tailwind scans source text:
 * green connected, amber slow, grey offline or reconnecting; transparent (with the old hover and
 * focus accent) for a logged-out visitor. Pure, so the mapping is a test.
 */
export function connectionRingClass(state: ConnectionState | null): string {
  switch (state) {
    case 'connected':
      return 'ring-green-ok';
    case 'slow':
      return 'ring-amber-warn';
    case 'offline':
    case 'reconnecting':
      return 'ring-text-muted';
    default:
      return 'hover:ring-accent-icon focus-visible:ring-accent-icon ring-transparent';
  }
}
