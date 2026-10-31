/**
 * The live session's "this group just became sendable" announcer, for the callers built OUTSIDE the
 * session layer.
 *
 * `sessionAuth`'s `announceGroupReady` is the one implementation of what a group becoming ready owes
 * (resume what the outbox held for it, refresh statuses, serve the askers it kept waiting, sweep the
 * invitations), and it needs the session's context. Two recovery callers are built by UI composables
 * that do not hold that context - the direct-conversation repair of `verifyCurrentUserMembership`
 * and the 1:1 repair of `startNewConversation` - so the session registers its announcer here, next to
 * the outbox it resumes, and those two capture it when they build their recovery deps.
 *
 * Registered and cleared with the outbox (`registerOutbox` / `unregisterOutbox`), so its lifetime is
 * the session's. A join landing with no session is not silent: the line says nothing was resumed.
 */

/** What a recovery calls when its group became sendable. */
export type GroupReadyAnnouncer = (groupId: string) => void;

let announcer: GroupReadyAnnouncer | null = null;

/** Installs the session's announcer (`null` on teardown). */
export function setGroupReadyAnnouncer(fn: GroupReadyAnnouncer | null): void {
  announcer = fn;
}

/**
 * The announcer of the session live NOW, read once - call it where the `RecoveryDeps` are built.
 *
 * READ AT THE BUILD, NEVER AT THE ANNOUNCEMENT: a recovery can outlive its session (a sign-out, or
 * an account switch, while the join is in flight), and a registry read when the join lands would
 * announce one session's group into the next session's outbox. Captured here, a recovery reaches the
 * session that started it, or nothing - and says so.
 *
 * AND THE CAPTURED SESSION MUST STILL BE THE LIVE ONE when the join lands. Its announcer resumes
 * through the module-level outbox (`resumeOutboxGroup`), which by then may be the next session's, so
 * a captured announcer whose session was torn down announces nothing.
 */
export function captureGroupReadyAnnouncer(): GroupReadyAnnouncer {
  const captured = announcer;
  return (groupId) => {
    if (captured && announcer === captured) {
      captured(groupId);
      return;
    }
    console.warn(
      `[GROUP_READY] ${groupId.slice(0, 8)}... became ready for a recovery whose session is not live (${captured ? 'ended since' : 'none at the start'}) - nothing was resumed`
    );
  };
}
