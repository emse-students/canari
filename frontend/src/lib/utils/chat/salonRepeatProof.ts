/**
 * WHETHER THE SERVER IS KNOWN TO ANSWER A REPEATED SALON SEND WITH ITS STORED ROW (WP-OFF-3).
 *
 * A send whose answer was lost may have landed. Repeating it is safe only on a server carrying
 * migration 090, which answers a repeat of the same client id with the row it already holds - an
 * older one ignores the id and posts the message twice. Production is deployed only once BOTH stores
 * serve the client, so a store build meets the old server for days, and a client cannot hope its
 * server is new: it must KNOW. The fact it reads is the answer itself - since 090 a send's answer
 * carries back the client id it was posted under (`clientMessageId`), which an older server never
 * does. One such answer proves it for this page life; no clock, no probe.
 *
 * What waits on the proof is only a repeat nobody asked for (the next page life resuming an
 * unanswered message, a send whose answer was lost as the link went down). A Retry is the author's
 * gesture and goes regardless.
 *
 * Memory only: the server is the same for the whole page life, and a new one learns it from its
 * first answer.
 */

let proven = false;
const waiters = new Set<() => void>();

/**
 * Reads one send's answer: `row` is what the server returned for a POST carrying `clientMessageId`.
 * The first answer echoing that id proves repeats safe and releases everything waiting on it.
 */
export function noteSalonSendAnswer(clientMessageId: string, row: unknown): void {
  if (proven) return;
  const echoed = (row as { clientMessageId?: unknown } | null)?.clientMessageId;
  if (typeof echoed !== 'string' || echoed.toLowerCase() !== clientMessageId.toLowerCase()) return;
  proven = true;
  console.log(
    `[SALON-REPEAT] the server echoed client id ${clientMessageId.slice(0, 8)}...: a repeated send is answered with its row - ${waiters.size} waiting repeat(s) released`
  );
  const released = [...waiters];
  waiters.clear();
  for (const release of released) {
    try {
      release();
    } catch (e) {
      console.error('[SALON-REPEAT] a released repeat threw:', e);
    }
  }
}

/** Whether a send's answer has proven, in this page life, that a repeat is answered with its row. */
export function salonRepeatIsSafe(): boolean {
  return proven;
}

/**
 * Runs `release` once a repeat is proven safe - at once when it already is.
 *
 * @returns a function that cancels the wait (the send was settled or given up meanwhile).
 */
export function whenSalonRepeatIsSafe(release: () => void): () => void {
  if (proven) {
    release();
    return () => {};
  }
  waiters.add(release);
  return () => waiters.delete(release);
}

/** Test seam: forgets the proof and every waiter. */
export function resetSalonRepeatProofForTests(): void {
  proven = false;
  waiters.clear();
}
