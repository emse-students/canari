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
 * The reason a key-group commit carries when the server answered 409 `SEAT_CLAIM_OVERTAKEN`: an
 * unrelated eviction moved the group's seat generation while the server asked who may hold a seat,
 * so the WHOLE commit was refused and nothing advanced. The epoch did not move, so a caller that
 * retries only past a moved epoch must retry on this reason too - each refusal proves an eviction.
 */
export const SEAT_CLAIM_OVERTAKEN_REASON = 'seat_claim_overtaken';

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
