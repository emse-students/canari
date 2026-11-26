/**
 * WHERE ONE COMMIT'S TIME UNDER THE MLS MUTEX GOES, for the line its acceptance writes.
 *
 * Every commit of this device runs alone under the global MLS mutex (`runCommitUnderMlsLock`):
 * stage, a checkpoint of the WHOLE state before the first request, the request, the merge. A device
 * answering a new device's restore commits one Add per group, so the restore's critical path is
 * that sum, group after group (`docs/wiki/backlog.d/p2-a-new-device-restore-is-paced-by-one-device-adding-it-group-by-group.md`).
 * Whether batching the Adds pays, and which half it must remove, is read off this line: the wait
 * for the mutex says how far the Adds queue behind each other, the checkpoint how much of the hold
 * grows with the number of groups, and the request how much is the network.
 *
 * A record of durations, never a decision: nothing reads it but the log.
 */
export interface CommitHoldTiming {
  /** When the transaction asked for the mutex. */
  readonly askedAt: number;
  /** When the mutex was granted, or null before. */
  grantedAt: number | null;
  /** Summed time of the checkpoints written before a first request (one per attempt). */
  checkpointMs: number;
  /** Summed time of the requests to the commit gate, first and resubmissions. */
  requestMs: number;
  /** Attempts staged (a commit rebuilt on an overtaken seat claim is a second attempt). */
  attempts: number;
}

/** The monotonic clock this module reads; `Date.now` where `performance` is absent (SSR, tests). */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Starts the record at the moment the transaction asks for the mutex. */
export function startCommitHoldTiming(): CommitHoldTiming {
  return { askedAt: now(), grantedAt: null, checkpointMs: 0, requestMs: 0, attempts: 0 };
}

/** Marks the grant of the mutex; a second call keeps the first grant. */
export function markCommitGranted(t: CommitHoldTiming): void {
  if (t.grantedAt === null) t.grantedAt = now();
}

/** Runs `work` and adds its duration to `field`, whether it resolves or throws. */
export async function timeCommitStep<T>(
  t: CommitHoldTiming,
  field: 'checkpointMs' | 'requestMs',
  work: () => Promise<T>
): Promise<T> {
  const started = now();
  try {
    return await work();
  } finally {
    t[field] += now() - started;
  }
}

/**
 * The clause the acceptance line carries: `waited 812 ms for the MLS mutex, held 431 ms (checkpoint
 * 96 ms, request 270 ms, 1 attempt)`. `endedAt` is the moment the hold ends (the merge done).
 */
export function describeCommitHold(t: CommitHoldTiming, endedAt: number = now()): string {
  const granted = t.grantedAt ?? t.askedAt;
  const waited = Math.max(0, Math.round(granted - t.askedAt));
  const held = Math.max(0, Math.round(endedAt - granted));
  const attempts = `${t.attempts} attempt${t.attempts === 1 ? '' : 's'}`;
  return (
    `waited ${waited} ms for the MLS mutex, held ${held} ms ` +
    `(checkpoint ${Math.round(t.checkpointMs)} ms, request ${Math.round(t.requestMs)} ms, ${attempts})`
  );
}
