/**
 * The window during which this device HOLDS a group it is not yet IN: an external commit built and
 * applied locally, submitted, and not yet answered by the commit gate.
 *
 * ## Why it has a name
 *
 * An external commit is applied to the instance it builds, so {@link holdsGroupState} answers `true`
 * - and the tree holds this device's leaf, so `isGroupActive` does too - from the moment the commit
 * is BUILT, under the MLS lock, until the gate answers, OUTSIDE it (a round trip is never held under
 * the client mutex). For that span "held" answers "have I asked to be in", not "am I in": a refusal
 * drops the state, an acceptance merges it.
 *
 * A Welcome arriving in that span read the first answer as the second. Measured on the iPhone 12,
 * `1.7.0-alpha.5`, 2026-11-16 (device-verification, fourth sitting b): a private salon's key group
 * was external-joined on a base read before the granting admin's Add; the admitter's Welcome landed
 * while that commit was in flight and was logged `already held - redelivered Welcome ignored
 * (idempotent)` and ACKed; the gate then refused the commit `epoch_mismatch`, the state was dropped,
 * and the retry read the seat as `welcome-queued` and waited for the Welcome just thrown away. The
 * salon stayed unreadable for good (`Group not found`, `no seed`).
 *
 * ## What it does
 *
 * `externalJoin` opens the window under the MLS lock BEFORE building (so no instant exists at which
 * the group is held by an unanswered commit and the window is closed) and closes it in a `finally`
 * once the gate's answer has been applied - merged, or dropped. A Welcome handler awaits
 * {@link awaitExternalCommitVerdict} before asking whether the group is held, so the question it
 * asks is answered by a settled group: accepted means joined (the Welcome is redundant), refused
 * means not held (the Welcome is the door and installs). No clock: the wait ends on the gate's
 * answer, which `submitCommit` always produces or throws.
 *
 * THE READ AND THE INSTALL ARE TWO STEPS, so the handler asks again UNDER THE LOCK
 * ({@link externalCommitAwaitsVerdict}) before it installs: a join whose base predated the Add can
 * take the lock between them and build, and the install would then hit a group held by an unanswered
 * commit. A window found open there sends the handler back to the settled read.
 *
 * THE COST, NAMED: a Welcome runs in the inbound drain, which is serial, so while one waits here
 * every later frame waits with it - for one commit round trip under the `write` deadline. It is met
 * only when a Welcome for a group lands inside this device's own external join of that group.
 *
 * Per service instance (a WeakMap), like `externalJoin`'s own flights: two devices in one test
 * process do not share windows.
 */

const windows = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Opens the unconfirmed-external-commit window for `groupId` and returns the function that closes
 * it. Closing is idempotent. Called by `externalJoin` only, under the MLS lock, before the build.
 *
 * @param owner the MLS service instance the commit is built on
 */
export function openExternalCommitWindow(owner: object, groupId: string): () => void {
  const byGroup = windows.get(owner) ?? new Map<string, Promise<void>>();
  windows.set(owner, byGroup);
  let close!: () => void;
  const settled = new Promise<void>((resolve) => {
    close = resolve;
  });
  byGroup.set(groupId, settled);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    // Identity-checked: a later attempt of the same join may own the entry by now.
    if (byGroup.get(groupId) === settled) byGroup.delete(groupId);
    close();
  };
}

/**
 * Waits until no external commit of `owner` for `groupId` is awaiting the gate's answer, so that
 * whatever the caller then reads about the group is a settled fact. Returns at once when none is.
 *
 * Loops, because one join's next attempt can open a new window as the last one closes; it ends when
 * the join does (its attempts are bounded).
 *
 * @returns whether it waited - the caller logs it, so a run shows the race was met and closed
 */
export async function awaitExternalCommitVerdict(owner: object, groupId: string): Promise<boolean> {
  let waited = false;
  for (;;) {
    const pending = windows.get(owner)?.get(groupId);
    if (!pending) return waited;
    waited = true;
    await pending;
  }
}

/**
 * Whether an external commit of `owner` for `groupId` is awaiting the gate's answer RIGHT NOW.
 *
 * Read by a Welcome handler UNDER THE MLS LOCK, as the first step of its install: the window opens
 * only under that lock, so this read and the install are atomic against it. The settled read of
 * {@link awaitExternalCommitVerdict} comes before the lock, and a join of the same group whose base
 * predated the Add can take the lock in between and build - an install then lands on a group held by
 * a commit nobody has accepted, the engine refuses it, and the Welcome is ACKed and gone. A `true`
 * here sends the handler back to the settled read; each return costs that join one of its bounded
 * attempts, so the loop ends.
 */
export function externalCommitAwaitsVerdict(owner: object, groupId: string): boolean {
  return windows.get(owner)?.has(groupId) ?? false;
}
