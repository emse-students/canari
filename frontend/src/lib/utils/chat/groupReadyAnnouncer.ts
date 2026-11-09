/**
 * The live session's "this group just became sendable" announcer, and the ONE check that a group
 * becoming ready is announced only into the session that started the work.
 *
 * `sessionAuth`'s `announceGroupReady` is the one implementation of what a group becoming ready owes:
 * resume what the outbox held for it, refresh statuses, serve the askers it kept waiting, sweep the
 * invitations. Every one of those reaches MODULE-LEVEL state - the outbox `resumeOutboxGroup` drains,
 * the deferred welcome requests, the invitation sweep - so an announcement that lands after a
 * sign-out and the next sign-in acts on the NEXT session (review of #2808). A Welcome processed late,
 * an external join awaited across the sign-out: both are ordinary, and both used to do it.
 *
 * So no caller holds `announceGroupReady` itself. The session registers it here, next to the outbox
 * it resumes (`registerOutbox` / `unregisterOutbox`), and EVERY `onGroupReady` - the message
 * pipeline's, the in-session `RecoveryDeps`, the two recovery callers built by UI composables -
 * is {@link captureGroupReadyAnnouncer}, taken when its deps are built. The captured announcer
 * forwards only while the registration it captured is still the live one.
 */

/** What a recovery or the message pipeline calls when its group became sendable. */
export type GroupReadyAnnouncer = (groupId: string) => void;

/** The live session's registration; a fresh object per session, so identity is the session. */
let live: { announce: GroupReadyAnnouncer } | null = null;

/** Installs the session's announcer (`null` on teardown). */
export function setGroupReadyAnnouncer(fn: GroupReadyAnnouncer | null): void {
  live = fn ? { announce: fn } : null;
}

/**
 * The announcer of the session live NOW - call it where the deps holding `onGroupReady` are built,
 * never at the announcement.
 *
 * The returned function forwards to that session while it is still the live one, and to nothing
 * after it ends. A session ending while a repair or a Welcome is in flight is an ordinary sign-out,
 * so that is said at `info`; work started with NO session live is a caller built out of order, and
 * that is a `warn`.
 */
export function captureGroupReadyAnnouncer(): GroupReadyAnnouncer {
  const captured = live;
  return (groupId) => {
    if (captured && live === captured) {
      captured.announce(groupId);
      return;
    }
    if (captured) {
      console.info(
        `[GROUP_READY] ${groupId.slice(0, 8)}... became ready after the session that asked for it ended - nothing announced`
      );
      return;
    }
    console.warn(
      `[GROUP_READY] ${groupId.slice(0, 8)}... became ready for work started with no live session - nothing announced`
    );
  };
}
