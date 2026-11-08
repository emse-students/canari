/**
 * Whether the header's connection pill reads "connected".
 *
 * Only the MLS leader tab holds the WebSocket; a follower tab delegates its commits to the leader
 * (`tabCommitDelegation.ts`) and so never has a socket of its own. Reading the socket alone made a
 * healthy follower say "Hors-ligne" - "I am not the writer" taken for "I have no network". A
 * follower's connection is its reachability, the same fact the offline banner reads.
 */
export function isHeaderConnected(input: {
  isWsConnected: boolean;
  isLoggedIn: boolean;
  isTabLeader: boolean;
  isOffline: boolean;
}): boolean {
  if (input.isWsConnected) return true;
  return input.isLoggedIn && !input.isTabLeader && !input.isOffline;
}
