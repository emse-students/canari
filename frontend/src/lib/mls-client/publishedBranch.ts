/**
 * WHETHER A COMMIT NOBODY ASKED FOR MAY BE STAGED: only on the branch the server publishes.
 *
 * The server's commit gate compares epoch NUMBERS. A device that merged a commit nobody else did
 * sits at the right number on the wrong branch, its next commit is accepted, and every healthy
 * member then fails to apply it. A commit a person asked for is that person's decision; a commit a
 * MECHANISM decides on its own - the periodic leaf refresh (`leafRefresh.ts`), the removal of a
 * revoked device's leaf or of a departed member's leaves found by a roster diff (`strayLeaves.ts`,
 * `rosterReconcile.ts`) - must not be what spreads a fork. So each is staged
 * only when this device's group context (tree hash, confirmed transcript hash) IS the external-join
 * base the server publishes for the epoch (`MlsManager::own_context_matches_base`), checked by
 * `BaseMlsService.assertOnPublishedBranch`.
 *
 * @see docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh
 */

/**
 * Why the server's published base could not vouch for this device's state.
 * - `no-base`: nothing is published for the group - nothing to compare against;
 * - `other-epoch`: the published base is of another epoch (this device is behind, or the base is);
 * - `diverged`: same epoch, different hashes - THIS DEVICE IS ON ANOTHER BRANCH. The only one that
 *   accuses: the throw site hands the group to the recovery ladder before throwing it.
 */
export type UnpublishedBranchReason = 'no-base' | 'other-epoch' | 'diverged';

/**
 * Thrown BEFORE anything is staged, when this device's group context is not the one the server
 * publishes for the epoch. Typed, so no caller reads the reason out of a message.
 */
export class UnpublishedBranchError extends Error {
  constructor(
    readonly groupId: string,
    readonly reason: UnpublishedBranchReason,
    /** What was not staged, for the log line: `leaf refresh`, `revoked-leaf removal`. */
    readonly what: string
  ) {
    super(`${what} of ${groupId.slice(0, 8)}... not vouched for by the published base: ${reason}`);
    this.name = 'UnpublishedBranchError';
  }
}
