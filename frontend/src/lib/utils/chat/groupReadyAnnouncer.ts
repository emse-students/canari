/**
 * The live session's "this group just became sendable" announcer, for the callers built OUTSIDE the
 * session layer.
 *
 * `sessionAuth`'s `announceGroupReady` is the one implementation of what a group becoming ready owes
 * (resume what the outbox held for it, refresh statuses, serve the askers it kept waiting, sweep the
 * invitations), and it needs the session's context. Two recovery callers are built by UI composables
 * that do not hold that context - the direct-conversation repair of `verifyCurrentUserMembership`
 * and the 1:1 repair of `startNewConversation` - so the session registers its announcer here, next to
 * the outbox it resumes, and those two reach it by name.
 *
 * Registered and cleared with the outbox (`registerOutbox` / `unregisterOutbox`), so its lifetime is
 * the session's. A join landing with no session is not silent: the line says nothing was resumed.
 */

let announcer: ((groupId: string) => void) | null = null;

/** Installs the session's announcer (`null` on teardown). */
export function setGroupReadyAnnouncer(fn: ((groupId: string) => void) | null): void {
  announcer = fn;
}

/**
 * Announces that `groupId` became sendable to the live session - see this module's doc.
 */
export function announceGroupReadyToSession(groupId: string): void {
  if (!announcer) {
    console.warn(
      `[GROUP_READY] ${groupId.slice(0, 8)}... became ready with no live session - nothing was resumed`
    );
    return;
  }
  announcer(groupId);
}
