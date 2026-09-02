/**
 * Keeps an application frame and a LOCAL epoch advance from overlapping, per group.
 *
 * ## The defect this deletes
 *
 * A send is two steps with a suspension between them: encrypt against the live client, then POST the
 * ciphertext. A commit is three: stage, have the server accept it, merge locally. Nothing used to
 * order the two, so this interleaving was reachable and cost real messages:
 *
 * ```
 *   encrypt(epoch N) ──────────────────────────────────┐
 *                     stage → server ACCEPTS N→N+1 ────┤   (the server fans the commit out here)
 *                     merge locally                    │
 *                                            POST(N) ──┘   (arrives after everyone reached N+1)
 * ```
 *
 * The frame is then a PAST-EPOCH frame for every recipient. OpenMLS retains two past epochs, so one
 * such straddle is usually survived - and that is exactly what made this invisible. Two commits in
 * quick succession close the window, and the frame becomes undecryptable for good: no retry, no
 * re-Welcome and no history bundle brings it back, because the recipient no longer holds the secrets
 * and the sender considers it delivered. Measured on production 2026-09-02 on DM `7da231f8`, where
 * the peer emitted seven application frames interleaved with its own commits 128 and 129, the first
 * of them 36 ms after the commit.
 *
 * ## Why a barrier and not a retry
 *
 * A stale frame COULD be detected after the fact and re-encrypted at the new epoch. That is a race
 * that heals cleanly, which this repository does not accept as a fix: the two paths would still
 * overlap and the heal would only hide it. Here the overlap is deleted - a frame is encrypted and on
 * the wire before a local commit starts, or it is encrypted after that commit merged. There is no
 * third ordering, and no clock anywhere in it.
 *
 * ## The lock order, which is what makes this deadlock-free
 *
 * A send waits for {@link runAsEpochAdvance}; an advance waits for the sends already registered. That
 * is a cycle unless one direction is impossible, so the rule is:
 *
 * **THE BARRIER MAY ONLY BE RAISED BY A HOLDER OF THE MLS CLIENT MUTEX.**
 *
 * `BaseMlsService.runCommitTransaction` raises it inside `runUnderMlsLock`. The mutex is exclusive,
 * so a send that observes a raised barrier provably does NOT hold the mutex, and therefore blocks
 * nothing the advance is waiting for. A caller that raised the barrier outside the mutex - or a send
 * issued from inside it - would reintroduce the cycle.
 *
 * Registered sends never need the mutex themselves (`encryptForSend` is a direct client call), so an
 * advance holding the mutex can wait for them to land.
 */

/** Groups whose epoch a local commit is currently moving; the promise resolves at the merge. */
const barriers = new Map<string, Promise<void>>();

/** Frames past their encrypt and not yet acknowledged by the delivery service, per group. */
const inFlight = new Map<string, Set<Promise<unknown>>>();

/**
 * Runs one application send for `groupId`, ordered against local epoch advances.
 *
 * Waits out any advance in progress, then registers itself so an advance starting next waits for
 * this frame to reach the wire. `fn` must cover BOTH the encrypt and the POST: registering only the
 * POST would leave the straddle this exists to delete.
 */
export async function runAsEpochSend<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  // A loop rather than a single await: the barrier that replaces this one belongs to a different
  // commit, and a frame encrypted between two of them is exactly as stale. It terminates because a
  // barrier is only ever raised while its raiser holds the MLS mutex, so raising one requires
  // completing the previous one.
  for (let barrier = barriers.get(groupId); barrier; barrier = barriers.get(groupId)) {
    // A failed commit does not move the epoch, so its rejection is not this send's business - what
    // matters is only that the transaction is over.
    await barrier.catch(() => undefined);
  }

  // NOT AWAITED BEFORE REGISTERING, and that is the whole point: `fn()` runs up to its first
  // suspension and comes back here with the frame not yet posted, so the registration below lands
  // before any other task can raise a barrier. An `await` on this line would open a window one
  // microtask wide - which is more than enough, the interleaving above being one await deep.
  const frame = fn();
  const frames = inFlight.get(groupId) ?? new Set<Promise<unknown>>();
  inFlight.set(groupId, frames);
  frames.add(frame);
  try {
    return await frame;
  } finally {
    frames.delete(frame);
    if (frames.size === 0) inFlight.delete(groupId);
  }
}

/**
 * Runs one local epoch advance for `groupId` - a commit, stage through merge - with sends held off.
 *
 * MUST be called while holding the MLS client mutex; see the lock order above. The barrier is raised
 * first and the in-flight frames are drained after, in that order, so a send racing the drain sees
 * the barrier and queues behind it instead of slipping through.
 */
export async function runAsEpochAdvance<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  barriers.set(
    groupId,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  try {
    // ONE PASS IS ENOUGH, and it is the barrier above that makes it so: every send now either is in
    // this set or has not encrypted yet. A loop here would be waiting for something that cannot
    // arrive.
    const frames = inFlight.get(groupId);
    // Iterated synchronously by `allSettled`, so a frame deleting itself from the set as it lands
    // cannot disturb the walk - no snapshot needed.
    if (frames?.size) await Promise.allSettled(frames);
    return await fn();
  } finally {
    // Deleted BEFORE resolving, so a send woken by the resolve re-reads the map and finds nothing
    // rather than the entry it was just released from.
    barriers.delete(groupId);
    release();
  }
}

/** True while a local commit holds `groupId`'s epoch open. Diagnostics and tests only. */
export function isEpochAdvanceInFlight(groupId: string): boolean {
  return barriers.has(groupId);
}

/** Drops all barrier state. Tests only - production has no reason to forget an in-flight commit. */
export function resetEpochSendBarrier(): void {
  barriers.clear();
  inFlight.clear();
}
