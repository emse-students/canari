/**
 * Tells the RETURN of the live stream after a real gap from every other reading of it.
 *
 * `isWsConnected` starts false, so the first `false -> true` of a session is the CONNECT, not a
 * return: the post-login listing already covers it, and listing again would be a second full listing
 * on every cold start and account switch. A return is an up that follows a DOWN after this session
 * already had an up. Logging out forgets everything, so the next account's connect is a connect.
 */
export function createLiveStreamGapEdge() {
  let upSeen = false;
  let previousUp: boolean | null = null;
  return {
    /** Feeds one reading; true exactly when it is the return from a gap. */
    observe(up: boolean, loggedIn: boolean): boolean {
      if (!loggedIn) {
        upSeen = false;
        previousUp = null;
        return false;
      }
      const wasDown = previousUp === false;
      previousUp = up;
      if (!up) return false;
      const isReturn = wasDown && upSeen;
      upSeen = true;
      return isReturn;
    },
  };
}
