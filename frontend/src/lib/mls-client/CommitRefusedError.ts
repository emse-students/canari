/**
 * The server's epoch gate refused a staged commit, which was then rolled back without a merge.
 *
 * A TYPE, BECAUSE A CALLER HAS TO TELL "SOMEBODY ELSE'S COMMIT WON" FROM "THIS FAILED". Until
 * 2026-09-28 the refusal was a plain `Error` whose only discriminator was its text, and the one
 * caller that needed the difference - the admitter of channel-encryption section 20 - gave up on
 * every refusal alike. Measured by NOTIF-21 that day: the newcomer's two live web clients joined
 * the key group by their own external commits in the same second the admitter's Add was built, the
 * Add was refused `epoch_mismatch`, and the newcomer's dead phone - the one device that could not
 * act for itself - was never added.
 *
 * The message keeps its historical spelling so a log reader and older assertions read it the same.
 */
/**
 * The reason a commit carries when the server answered 409 `SEAT_CLAIM_OVERTAKEN` on every one of
 * its {@link SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS} submissions: each time, an unrelated eviction moved
 * the group's seat generation while a seat the commit writes was being decided, so the WHOLE commit
 * was refused and nothing advanced. The epoch did not move, so a caller that retries only past a
 * moved epoch must retry on this reason too - each refusal proves an eviction.
 */
export const SEAT_CLAIM_OVERTAKEN_REASON = 'seat_claim_overtaken';

/**
 * How many times `runCommitTransaction` submits one commit the server refuses `SEAT_CLAIM_OVERTAKEN`,
 * rebuilding it in between. A BOUND, NOT THE TERMINATION CONDITION: each refusal proves an eviction
 * landed in that window, and evictions are rare; this only keeps a group evicting without pause
 * from holding the MLS lock.
 */
export const SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS = 3;

/**
 * The reason a commit carries when it was not even staged because its transaction had spent the
 * MLS lock budget (`COMMIT_LOCK_HOLD_BUDGET_MS`, `commitSubmission.ts`) settling an earlier commit
 * of the group. Nothing was sent; the settlement moved the group, so a retry builds on its result.
 */
export const COMMIT_LOCK_BUDGET_SPENT_REASON = 'lock_budget_spent';

export class CommitRefusedError extends Error {
  /**
   * @param reason - the server's refusal reason (`epoch_mismatch`, `concurrent_commit`, ...).
   * @param baseEpoch - the epoch the refused commit was built on.
   * @param currentEpoch - the server's epoch at the refusal, when it reported one.
   * @param retryAfterMs - `rate_limited` only: how long the server asked this account to wait
   *   before its next commit (`commitRateLimit.ts`); null for every other reason, or
   *   when the server named no wait.
   */
  constructor(
    readonly reason: string,
    readonly baseEpoch: number,
    readonly currentEpoch: number | undefined,
    readonly retryAfterMs: number | null = null
  ) {
    super(`Staged commit rejected: ${reason}`);
    this.name = 'CommitRefusedError';
  }
}

/**
 * Why a commit the server REFUSED may be rebuilt and submitted again, or `null` when it may not.
 *
 * THE ONE RULE FOR EVERY CALLER THAT REBUILDS A MEMBER'S GESTURE (an admission, a removal), so a
 * lost race ends the same way whoever lost it. TERMINATION IS A PROOF, NEVER A COUNT:
 *
 * - `epoch-moved`: the refusal's catch-up (`catchUpOnRefusedCommit`) took the local epoch past the
 *   one the commit was built on, so one foreign commit was consumed - a rebuild reads the tree that
 *   commit left. A refusal that moved nothing proves nothing, and ends the gesture;
 * - `seat-claim-overtaken`: the whole commit was refused because an unrelated eviction moved the
 *   group's seat generation on every submission `runCommitTransaction` made - each refusal proves
 *   an eviction landed, and the epoch stood still, so the rebuild stages on the same tree.
 *
 * Read from the TYPE and its `reason` field, never from the message.
 *
 * @param error - what the commit threw.
 * @param builtOn - the local epoch the commit was staged on, read before it was.
 * @param epochNow - the local epoch after the refusal.
 */
export function rebuildableRefusal(
  error: unknown,
  builtOn: number,
  epochNow: number
): 'epoch-moved' | 'seat-claim-overtaken' | null {
  if (!(error instanceof CommitRefusedError)) return null;
  if (epochNow > builtOn) return 'epoch-moved';
  if (error.reason === SEAT_CLAIM_OVERTAKEN_REASON) return 'seat-claim-overtaken';
  return null;
}
