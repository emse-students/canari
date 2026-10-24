/**
 * THE SERVER'S "NOT BEFORE" FOR THIS ACCOUNT'S NEXT COMMIT, after `POST /mls/commit` answered `429`.
 *
 * The limit is per USER on the server (`MLS_COMMIT_LIMIT_PER_MINUTE`), so once it has refused one
 * commit it refuses every commit of this account until the wait it named has passed - asking again
 * group after group only collects one `429` per group and moves the wait nowhere. So the wait is
 * recorded here, ONE value for the process, and read by every commit path before it submits and by
 * every sweep before it starts the next group.
 *
 * This is the server's answer, kept for as long as it said it holds - not a timer of the client's.
 * Nothing here decides that something happened; it only declines to ask a question the server has
 * already answered for this long.
 */

let notBeforeMs = 0;

/**
 * Records a `429` from the commit gate: commits are refused until `now + retryAfterMs`. A later
 * wait never shortens an earlier one.
 *
 * @param retryAfterMs the server's `retryAfterMs`; a refusal that named none counts as one second,
 *   the throttler's smallest unit.
 */
export function noteCommitRateLimited(retryAfterMs: number | null, now = Date.now()): void {
  const until = now + Math.max(1000, retryAfterMs ?? 1000);
  if (until > notBeforeMs) notBeforeMs = until;
  console.warn(
    `[COMMIT] rate-limited by the server - no commit is submitted for ${Math.round((notBeforeMs - now) / 1000)} s`
  );
}

/** How long, in ms, the server still refuses this account's commits; 0 when it does not. */
export function commitRateLimitRemainingMs(now = Date.now()): number {
  return Math.max(0, notBeforeMs - now);
}

/** Forgets the recorded wait (tests). */
export function resetCommitRateLimit(): void {
  notBeforeMs = 0;
}
