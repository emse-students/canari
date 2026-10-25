/**
 * The server RECORDED a removal - the roster no longer names the member, no frame reaches them - but
 * the Remove commit that takes their leaves out of the tree did NOT land, and could not be rebuilt.
 *
 * A TYPE, BECAUSE THE PERSON WHO ASKED MUST BE TOLD, AND TOLD THE RIGHT THING. Until 2026-10-25 a lost
 * commit race reached the caller as a bare `CommitRefusedError` that it only logged: the gesture
 * looked done, the tree lagged the roster, and the member's leaves kept every new epoch until a
 * holder's next connection collected them (`removeStrayLeaves`). The removal is not undone - the
 * record is the removal (user, 2026-10-14) - so the sentence is "removed, the key change follows",
 * never "failed".
 *
 * `cause` is what the last commit attempt threw (a refusal that moved nothing, an unknown outcome,
 * an unreadable tree), kept for the log, never read for a decision.
 */
export class MemberRemovalNotCommittedError extends Error {
  constructor(
    readonly groupId: string,
    readonly memberId: string,
    readonly cause: unknown
  ) {
    super(
      `the removal of ${memberId.slice(0, 8)} from ${groupId.slice(0, 8)}... is recorded on the ` +
        `server, but its Remove commit did not land (${String(cause).slice(0, 120)})`
    );
    this.name = 'MemberRemovalNotCommittedError';
  }
}
