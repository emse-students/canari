/**
 * ROWS BEFORE RATCHET, THE DECRYPT HALF (P1, review of #3321; the backlog's first window).
 *
 * A checkpoint stores the rows its observers buffer before it exports (`holdRowsForCheckpoint`),
 * but a row is not in any buffer yet while its frame is between the decrypt and the row's write: the
 * handler has spent the generation (the ratchet advance is in the state the export takes) and has
 * not reached `addMessageToChat`, or reached it and its write is still in flight. An export taken
 * there, then a kill, lost the message: the generation is spent on disk and the frame is marked seen.
 *
 * THE ORDER: a handler marks a row OWED right before it decrypts an application frame and settles
 * the mark once the row is stored or buffered (or once it knows the frame carries no row). A
 * checkpoint {@link RowsOwedLedger.hold | holds} the ledger before it asks the observers for their
 * rows: from that instant no new mark is taken - a decrypt that has not marked waits at the gate,
 * BEFORE it decrypts - and the hold resolves when every mark taken before it settled. So the export
 * claims no advance whose row is neither stored nor in a buffer the observers then store.
 *
 * WHY IT TERMINATES, WITHOUT A CLOCK: the set of marks is closed when the hold is taken, and each
 * mark is settled by its own handler on a path that never awaits a checkpoint - a frame that may
 * need one (a commit, a system event, an eviction) settles its mark BEFORE that work, or never takes
 * one. That is the invariant every caller of {@link RowsOwedLedger.owe} keeps, and the reason the
 * mark spans the decrypt and the row's write and nothing else.
 *
 * THE LIVENESS COUPLING, STATED (review of #3851): while a hold stands, NO application frame is
 * decrypted. So a row write that never settles holds every checkpoint (exactly as a hung buffered
 * write does, `holdRowsForCheckpoint` - exporting past a row not stored is the loss itself), AND that
 * checkpoint's closed gate holds every inbound decrypt behind it. The gate reopens at the export's
 * CAPTURE where the platform has one (the web: `checkpointCapturesAtCall`), so a slow or hung seal
 * and put never stop the drain there; on native the export runs inside the command, so the gate
 * stays closed for the whole write (~1.7 s on the phone) and a hung command stops the drain.
 * See docs/wiki/frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-2026-11-19.
 */

/** The settle of one owed row: idempotent, so a handler may settle early and in its `finally`. */
export type RowOwed = () => void;

export class RowsOwedLedger {
  /** Marks taken and not settled yet: one per application frame between its decrypt and its row. */
  private owed = 0;
  /** Checkpoints holding the ledger: while any does, no new mark is taken. */
  private holds = 0;
  /** Decrypts waiting at the closed gate; woken when the last hold is released. */
  private gateWaiters: Array<() => void> = [];
  /** Holds waiting for the marks taken before them to settle. */
  private settledWaiters: Array<() => void> = [];

  /**
   * Marks one row owed, waiting first while a checkpoint holds the ledger. Call it IMMEDIATELY
   * before the decrypt, with nothing awaited between its resolution and the decrypt's call, and
   * settle the returned mark once the row is stored or buffered, or known not to exist - always
   * before awaiting anything that may await a checkpoint.
   */
  async owe(): Promise<RowOwed> {
    if (this.holds > 0) {
      // AT LOG, ONCE PER WAIT (review of #3851): the attribution of a drain that stalls behind a
      // checkpoint - at debug, the one line naming the cause of a stopped drain was filtered out.
      console.log(
        `[ROWS_OWED] A decrypt waits for ${this.holds} checkpoint(s) to take their export first`
      );
    }
    // RE-READ AFTER EVERY WAKE: a checkpoint taken between the release that woke this waiter and
    // its turn closes the gate again, and a mark taken then would be outside that hold's set.
    while (this.holds > 0) {
      await new Promise<void>((resolve) => this.gateWaiters.push(resolve));
    }
    // TAKEN IN THE TURN THE GATE WAS READ OPEN: a hold taken after this line waits for this mark.
    this.owed += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.owed -= 1;
      if (this.owed === 0) {
        const waiters = this.settledWaiters.splice(0);
        for (const wake of waiters) wake();
      }
    };
  }

  /**
   * Closes the gate and resolves, with the release, once every mark taken before settled. The
   * release reopens the gate when no other hold stands; call it once the export is CAPTURED - at the
   * call on the web, at the write's end on native, where the export runs inside the command.
   */
  async hold(): Promise<() => void> {
    this.holds += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        const waiters = this.gateWaiters.splice(0);
        for (const wake of waiters) wake();
      }
    };
    if (this.owed > 0) {
      // Said only when it waits: the line that explains a checkpoint exporting a few ms late.
      console.log(
        `[ROWS_OWED] A checkpoint waits for ${this.owed} decrypted frame(s) to store their rows before it exports`
      );
      // The gate is closed, so the count only goes down from here: one wake per return to zero.
      while (this.owed > 0) {
        await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
      }
    }
    return release;
  }

  /** How many marks stand now (tests and the log). */
  get owedCount(): number {
    return this.owed;
  }
}
