/**
 * Why a recorded removal is not COMPLETE in this device's tree:
 * - `commit-not-landed`: the Remove commit did not land and could not be rebuilt, and the member
 *   still holds a leaf (or the outcome of the commit is unknown);
 * - `tree-unconfirmed`: the tree here holds no leaf of theirs, but it could not be confirmed to be
 *   the server's latest - a tree behind an Add would say "out" of a member still in.
 */
export type RemovalIncompleteReason = 'commit-not-landed' | 'tree-unconfirmed';

/**
 * The server RECORDED a removal - the roster no longer names the member, no frame reaches them - but
 * this device cannot say their leaves are out of the tree.
 *
 * A TYPE, BECAUSE THE PERSON WHO ASKED MUST BE TOLD, AND TOLD THE RIGHT THING. Until 2026-10-25 a lost
 * commit race reached the caller as a bare `CommitRefusedError` that it only logged: the gesture
 * looked done, the tree lagged the roster, and the member's leaves kept every new epoch until a
 * holder's next connection collected them (`removeStrayLeaves`). The removal is not undone - the
 * record is the removal (user, 2026-10-14) - so the sentence is "removed, the key change follows",
 * never "failed".
 *
 * `cause` (the standard `Error.cause`) is what the last attempt threw, kept for the log and for one
 * reader that unwraps by TYPE: a follower-tab refusal still reaches its own sentence.
 */
export class MemberRemovalNotCommittedError extends Error {
  constructor(
    readonly groupId: string,
    readonly memberId: string,
    readonly why: RemovalIncompleteReason,
    cause: unknown
  ) {
    super(
      `the removal of ${memberId.slice(0, 8)} from ${groupId.slice(0, 8)}... is recorded on the ` +
        `server, but is not complete in the tree (${why}: ${String(cause).slice(0, 120)})`,
      { cause }
    );
    this.name = 'MemberRemovalNotCommittedError';
  }
}
