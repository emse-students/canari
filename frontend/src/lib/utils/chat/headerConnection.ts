/**
 * Whether the header's connection pill reads "connected".
 *
 * Only the MLS leader tab holds the WebSocket; a follower tab delegates its commits to the leader
 * (`tabCommitDelegation.ts`) and has no socket of its own. Reading the socket alone made a healthy
 * follower say "Hors-ligne". A follower's connection IS its leader's socket, which the leader
 * publishes to it (`tabLeaderLink.svelte.ts`): no leader answering reads offline. Neither
 * `navigator.onLine` nor a reachability guess enters into it.
 */
export function isHeaderConnected(input: {
  isWsConnected: boolean;
  isLoggedIn: boolean;
  isTabLeader: boolean;
  /** The leader's published socket state, false while no leader has answered. */
  leaderConnected: boolean;
}): boolean {
  if (input.isWsConnected) return true;
  return input.isLoggedIn && !input.isTabLeader && input.leaderConnected;
}
