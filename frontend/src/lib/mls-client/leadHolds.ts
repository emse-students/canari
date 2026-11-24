/**
 * THE LEAD STAYS WHILE MLS WORK THAT NEEDS IT IS IN FLIGHT (review of #4053, 2026-11-24).
 *
 * A tab whose session can no longer serve gives the lead up (`setTabLeadEligibility`), and from
 * then on the write latch refuses its checkpoints (`refusesCommitsHere` at the put). Given up at the
 * instant the session flag falls, that refused the very writes the session still owed: a commit
 * already posted to the server whose checkpoint had not landed yet, an external join, a key package
 * minted and not yet stored, a sign-out's final checkpoint. Each would be
 * redone by the next leader at best, and a commit's ratchet advance was lost outright.
 *
 * So every such operation is COUNTED here while it runs, and the lead is given up only once the count
 * is zero: termination comes from each operation settling - on success or on failure, the `finally`
 * below - never from a clock. The holds are taken WHERE THE STATE CHANGES, so no path can forget one
 * (second review of #4053): the MLS mutex from its grant to its release (`MlsPerGroupScheduler`,
 * every frame, Welcome, commit, catch-up and rejoin), an external join from its build to its
 * structural checkpoint (its commit is on the wire between two lock sections), a distribution group
 * created here from its creation to the checkpoint covering its published base, a key-package mint
 * and the identity rotation in it, a checkpoint from its export to its put, an ended session's
 * final checkpoint. A wait that changes no state - for the mutex itself, for a salon's send gate -
 * holds nothing. What a hold can wait on ends on its own: a request in an answer or a transport
 * failure, an IndexedDB put in success or error, the encrypt worker's round trip in a reply, an
 * error, or its termination (`mlsEncryptWorkerSession`).
 *
 * The count is per document and says nothing about the role: a follower's operation is refused at
 * its own entry and settles at once. Only the session's eligibility reads it (`leadPublisher.ts`),
 * told through {@link onLeadHoldsReleased}, and a session that ends with holds in flight names them
 * ({@link describeLeadHolds}).
 */

let inFlight = 0;
/** What each hold in flight is, by a token of its own: what {@link describeLeadHolds} names. */
const holding = new Map<symbol, string>();
const releasedListeners = new Set<() => void>();

/**
 * Counts one operation that needs the lead from NOW - synchronously, so a flag that falls right
 * after the call already sees it - and returns its release. The release is idempotent: a second
 * call is a no-op, so a caller can release from every exit without counting twice.
 */
export function takeLeadHold(what: string): () => void {
  inFlight += 1;
  const token = Symbol(what);
  holding.set(token, what);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    holding.delete(token);
    if (inFlight > 0) return;
    // Isolated per listener: one that throws must not keep the lead from being given up elsewhere.
    for (const listener of releasedListeners) {
      try {
        listener();
      } catch (e) {
        console.warn(`[TAB] a lead-hold listener threw after "${what}" settled: ${String(e)}`);
      }
    }
  };
}

/** Runs `work` with the lead held (see {@link takeLeadHold}); the hold ends when `work` settles. */
export async function holdLeadWhile<T>(what: string, work: () => Promise<T>): Promise<T> {
  const release = takeLeadHold(what);
  try {
    return await work();
  } finally {
    release();
  }
}

/** How many operations that need the lead are running in this document. */
export function leadHoldsInFlight(): number {
  return inFlight;
}

/** The holds in flight, named - what a session that ends while any is in flight says it waits for. */
export function describeLeadHolds(): string {
  return [...holding.values()].join(', ');
}

/** Registers `listener`, called each time the count comes back to zero. Returns its removal. */
export function onLeadHoldsReleased(listener: () => void): () => void {
  releasedListeners.add(listener);
  return () => releasedListeners.delete(listener);
}

/** @internal Test seam: no operation in flight, nobody listening. */
export function resetLeadHoldsForTests(): void {
  inFlight = 0;
  holding.clear();
  releasedListeners.clear();
}
