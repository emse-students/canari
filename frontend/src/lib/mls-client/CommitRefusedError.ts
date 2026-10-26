import { ApiRefusalError } from '$lib/utils/apiRefusalError';

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
 * Whether `error` is the gate refusing a commit because ANOTHER commit took, or was taking, the same
 * epoch: `epoch_mismatch` (it landed) or `concurrent_commit` (it held the gate's lock). Both are the
 * same race seen at two instants, and every caller reads them alike - by the TYPE and its `reason`
 * field, never the message.
 */
export function isCommitRaceRefusal(error: unknown): error is CommitRefusedError {
  return (
    error instanceof CommitRefusedError &&
    (error.reason === 'epoch_mismatch' || error.reason === 'concurrent_commit')
  );
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
 * NEVER A REFUSAL THE CLIENT ITSELF DECIDED: `rate_limited` (the server asked this account to wait)
 * and `lock_budget_spent` (nothing was even staged) are not races, and a rebuild would only meet them
 * again - whatever the epoch did meanwhile.
 *
 * Read from the TYPE and its fields, never from the message. The epoch is compared with the one the
 * refused commit RECORDED (`baseEpoch`), not one read before the call: a frame processed between that
 * read and the stage would otherwise count as progress the refusal did not make.
 *
 * @param error - what the commit threw.
 * @param epochNow - the local epoch after the refusal.
 */
export function rebuildableRefusal(
  error: unknown,
  epochNow: number
): 'epoch-moved' | 'seat-claim-overtaken' | null {
  if (!(error instanceof CommitRefusedError)) return null;
  if (error.reason === 'rate_limited' || error.reason === COMMIT_LOCK_BUDGET_SPENT_REASON)
    return null;
  if (epochNow > error.baseEpoch) return 'epoch-moved';
  if (error.reason === SEAT_CLAIM_OVERTAKEN_REASON) return 'seat-claim-overtaken';
  return null;
}

/**
 * The people a commit was refused WHOLE for, or `null` when `error` is not that refusal: the
 * server's 409 `ADMIT_REFUSED`, which the gate answers when the commit would give a leaf to a person
 * it may not admit (a departure or a Decline recorded after the Add was decided, a block). Nothing
 * advanced and nobody got a leaf; a commit rebuilt WITHOUT the named people may be submitted again,
 * and one that still names them meets the same answer. Read off the typed status, code and list,
 * never the message. An empty list names nobody, so it proves nothing a rebuild could drop.
 */
export function refusedAdmits(error: unknown): string[] | null {
  return error instanceof ApiRefusalError && error.status === 409 && error.code === 'ADMIT_REFUSED'
    ? (error.userIds ?? [])
    : null;
}
