/**
 * Centralized classification of errors raised while REMOVING a leaf from an MLS group.
 *
 * The sibling of `mlsSendError.ts` and `mlsDecryptError.ts`, written for the same reason and after
 * the same kind of incident: "the Remove did not happen" is not one thing, and the two things it
 * collapses want OPPOSITE next actions.
 *
 *   - **The leaf was never there.** The tree already looks the way the caller wanted it to look.
 *     Nothing was staged, nothing needs merging, and the caller may proceed exactly as if it had
 *     removed something.
 *   - **The Remove was refused.** The leaf is STILL IN THE TREE. Anything the caller does next that
 *     assumes an absent leaf is now wrong.
 *
 * WHY THAT DISTINCTION IS LOAD-BEARING RATHER THAN TIDY. `kickStaleLeaf` removes a stale leaf and
 * then clears the device's routing row to `pending`. Since 2026-09-04 a `pending` row with no queued
 * Welcome and no add lock is an INVITATION: the device stops waiting for a member and joins by
 * external commit, which is what ended the livelock in `docs/wiki/backlog.md`. So clearing that row
 * while the old leaf is still in the tree asks the device to add a SECOND leaf beside it - the
 * duplicate-leaf race of 2026-08-26 (GRP-4), reached from the other side. The repair would create
 * the fault it exists to clean up.
 *
 * The classification is made in Rust, on the error VARIANT (`MlsError::NoSuchMember`,
 * `frontend/mls-core/src/members.rs`), because that is where the type still exists; what crosses the
 * WASM/Tauri boundary is a string, so the variant is carried as a stable machine token this
 * repository defines - the same family as `EVICTED:`, `UNRECOVERABLE:` and `ALREADY_MEMBER:`.
 * **Matching it is reading a discriminator, not parsing prose**, and this module is the only place
 * that reads it. Before it existed both outcomes were one
 * `OpenMls("No member found for identities: ...")`, and the single call site that cared had no way
 * to tell them apart without a substring match on an OpenMLS message.
 */

/** What a failed Remove says about the state of the tree. */
export type MlsRemoveErrorKind =
  /**
   * `NO_SUCH_MEMBER`: no leaf carried the named identity, so there was nothing to remove and the
   * tree is already in the state the caller asked for. **Not a failure** - a caller whose goal is
   * "this leaf must not be in the tree" has that goal met.
   */
  | 'already-absent'
  /**
   * Everything else: the Remove did not take effect and the leaf must be assumed PRESENT. Staged
   * commits are cleared server-side without advancing the local epoch (`runCommitTransaction`), so
   * there is no fork to repair - but there is also no removal, and a caller that writes state
   * describing an absent leaf is writing a lie.
   */
  | 'still-present';

/**
 * Classifies a failure from `removeMemberDevice` / `removeMember`.
 *
 * FAILS TOWARDS `still-present`, deliberately. The two mistakes are not symmetric: reading a real
 * refusal as `already-absent` lets a caller clear a routing row for a leaf that is still in the
 * tree, which invites a duplicate leaf; reading an already-absent leaf as `still-present` only
 * leaves a routing row uncleared, which the next repair pass revisits. An unrecognised error is
 * therefore the dangerous one only if it is guessed generously, so it is not.
 */
export function classifyRemoveError(error: unknown): MlsRemoveErrorKind {
  return String(error).includes('NO_SUCH_MEMBER:') ? 'already-absent' : 'still-present';
}
