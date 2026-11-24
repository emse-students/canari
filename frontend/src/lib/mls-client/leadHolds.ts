/**
 * THE LEAD STAYS WHILE MLS WORK THAT NEEDS IT IS IN FLIGHT (review of #4053, 2026-11-24).
 *
 * A tab whose session can no longer serve gives the lead up (`setTabLeadEligibility`), and from
 * then on the write latch refuses its checkpoints (`refusesCommitsHere` at the put). Given up at the
 * instant the session flag falls, that refused the very writes the session still owed: a commit
 * already posted to the server whose checkpoint had not landed yet, a delegated executor half-way
 * through, a key package minted and not yet stored, a sign-out's final checkpoint. Each would be
 * redone by the next leader at best, and a commit's ratchet advance was lost outright.
 *
 * So every such operation is COUNTED here while it runs, and the lead is given up only once the count
 * is zero: termination comes from each operation settling - on success or on failure, the `finally`
 * below - never from a clock. Every operation counted here ends on its own: a commit's requests end
 * in an answer or a transport failure, a checkpoint in a landed or refused put, the encrypt worker's
 * round trip in a reply, an error, or its own termination (`mlsEncryptWorkerSession`).
 *
 * The count is per document and says nothing about the role: a follower's operation is refused at
 * its own entry and settles at once. Only the session's eligibility reads it
 * (`useChatSession.publishDelegationReadiness`), told through {@link onLeadHoldsReleased}.
 */

let inFlight = 0;
const releasedListeners = new Set<() => void>();

/**
 * Counts one operation that needs the lead from NOW - synchronously, so a flag that falls right
 * after the call already sees it - and returns its release. The release is idempotent: a second
 * call is a no-op, so a caller can release from every exit without counting twice.
 */
export function takeLeadHold(what: string): () => void {
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
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

/** Registers `listener`, called each time the count comes back to zero. Returns its removal. */
export function onLeadHoldsReleased(listener: () => void): () => void {
  releasedListeners.add(listener);
  return () => releasedListeners.delete(listener);
}

/** @internal Test seam: no operation in flight, nobody listening. */
export function resetLeadHoldsForTests(): void {
  inFlight = 0;
  releasedListeners.clear();
}
