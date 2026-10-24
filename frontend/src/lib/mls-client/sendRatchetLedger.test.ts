// @vitest-environment happy-dom
import {
  MAX_BURN_GENERATIONS,
  commitPersisted,
  forgetSendRatchetEntries,
  noteFrameEmitted,
  readSendRatchetLedgerForTest,
  resetSendRatchetLedger,
  sendRatchetDebt,
  sendRatchetEntries,
  snapshotEmitted,
  type SendRatchetDebt,
} from './sendRatchetLedger';

/**
 * THE COUNTER THAT SURVIVES A LOST CHECKPOINT.
 *
 * Every case here is about the ONE decision this module makes - how far behind the restored snapshot
 * is, and in WHICH EPOCH - and about the direction it is allowed to be wrong in. Over-shooting costs
 * a receiver a few unused keys; under-shooting re-issues a spent generation and the peer refuses the
 * frame. So the ordering test below is not a detail of the API, it is the guarantee.
 */
const U = 'user-1';
const G = 'group-a';

/** Every entry's debt against a state restored at `restored` (one epoch for every group here). */
function debts(
  restored: number
): Array<{ groupId: string; epoch: number | null } & SendRatchetDebt> {
  return sendRatchetEntries(U).map((e) => ({
    groupId: e.groupId,
    epoch: e.epoch,
    ...sendRatchetDebt(e, restored),
  }));
}

describe('sendRatchetLedger', () => {
  beforeEach(() => localStorage.clear());

  it('reports nothing when nothing has been sent', () => {
    expect(sendRatchetEntries(U)).toEqual([]);
  });

  it('counts emitted frames per group AND epoch, and keeps both apart', () => {
    noteFrameEmitted(U, G, 4);
    noteFrameEmitted(U, G, 4);
    noteFrameEmitted(U, G, 5);
    noteFrameEmitted(U, 'group-b', 4);

    expect(debts(4)).toEqual([
      { groupId: G, epoch: 4, kind: 'burn-now', count: 2, clamped: false },
      { groupId: G, epoch: 5, kind: 'on-arrival', count: 1, clamped: false },
      { groupId: 'group-b', epoch: 4, kind: 'burn-now', count: 1, clamped: false },
    ]);
  });

  it('keeps two users apart in one browser profile', () => {
    noteFrameEmitted(U, G, 1);
    expect(sendRatchetEntries('user-2')).toEqual([]);
  });

  it('clears the deficit once a checkpoint declares those frames durable', () => {
    noteFrameEmitted(U, G, 1);
    noteFrameEmitted(U, G, 1);
    commitPersisted(U, snapshotEmitted(U));

    expect(debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
  });

  /**
   * THE ORDER IS THE GUARANTEE, AND THIS IS THE CASE THAT PINS IT.
   *
   * A checkpoint reads the count BEFORE it starts writing and commits it AFTER the write lands. A
   * send in that window belongs to neither: the snapshot on disk does not contain it. Counting it as
   * persisted - which is what reading the count after the write would do - is exactly the defect,
   * silently, and no later run could tell.
   */
  it('counts a send that lands DURING a checkpoint as unpersisted', () => {
    noteFrameEmitted(U, G, 1); // the frame the checkpoint will contain
    const inFlight = snapshotEmitted(U); // read before the write starts
    noteFrameEmitted(U, G, 1); // a send while the disk is busy
    commitPersisted(U, inFlight); // committed after it lands

    expect(debts(1)).toEqual([
      { groupId: G, epoch: 1, kind: 'burn-now', count: 1, clamped: false },
    ]);
  });

  it('never lets a late checkpoint un-declare what a later one made durable', () => {
    noteFrameEmitted(U, G, 1);
    const early = snapshotEmitted(U);
    noteFrameEmitted(U, G, 1);
    commitPersisted(U, snapshotEmitted(U)); // the later checkpoint wins
    commitPersisted(U, early); // and the straggler must not undo it

    expect(debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
    expect(readSendRatchetLedgerForTest(U).persisted[`${G}@1`]).toBe(2);
  });

  /**
   * THE EPOCH IS WHAT DECIDES WHERE A COUNT IS OWED (2026-10-23). A state restored at 4 holds epoch
   * 4's ratchet as the last checkpoint left it, and nothing of epoch 5: frames sent at 5 after a merge
   * that checkpoint does not hold are ALL owed, and owed at 5 - a merge restarts 5 at generation 0.
   * Frames at 3 are past: no ratchet will send there again.
   */
  it('places each count in its epoch: the restored one, one ahead of it, one behind it', () => {
    noteFrameEmitted(U, G, 3);
    noteFrameEmitted(U, G, 4);
    noteFrameEmitted(U, G, 5);
    noteFrameEmitted(U, G, 5);
    // A checkpoint that saw epoch 5's first frame cannot be the one restored at 4, but a count it
    // committed must still not shrink what epoch 5 owes a state that never reached it.
    commitPersisted(U, { [`${G}@5`]: 1 });

    expect(debts(4)).toEqual([
      { groupId: G, epoch: 3, kind: 'spent' },
      { groupId: G, epoch: 4, kind: 'burn-now', count: 1, clamped: false },
      { groupId: G, epoch: 5, kind: 'on-arrival', count: 2, clamped: false },
    ]);
  });

  /**
   * An entry written before epochs were kept (`docs/wiki/legacy-compatibility.md`) is counted the
   * way the client that wrote it counted: against the epoch the state is restored at.
   */
  it('reads a pre-epoch entry against the restored epoch, as its writer did', () => {
    localStorage.setItem(
      `mls_send_ledger_${U}`,
      JSON.stringify({ emitted: { [G]: 3 }, persisted: { [G]: 1 } })
    );

    expect(debts(7)).toEqual([
      { groupId: G, epoch: null, kind: 'burn-now', count: 2, clamped: false },
    ]);
  });

  /**
   * The background sender on Android/iOS persists inside its own batch and never touches this
   * ledger, so a device that sent while backgrounded comes back with a snapshot AHEAD of these
   * counters. There is nothing to repair in that direction, and a burn there would be pure waste.
   */
  it('reports nothing when the snapshot is AHEAD of the counters', () => {
    commitPersisted(U, { [`${G}@1`]: 5 });
    noteFrameEmitted(U, G, 1);

    expect(debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
  });

  it('clamps an impossible deficit and SAYS it clamped', () => {
    localStorage.setItem(
      `mls_send_ledger_${U}`,
      JSON.stringify({ emitted: { [`${G}@1`]: MAX_BURN_GENERATIONS + 500 }, persisted: {} })
    );

    expect(debts(1)).toEqual([
      { groupId: G, epoch: 1, kind: 'burn-now', count: MAX_BURN_GENERATIONS, clamped: true },
    ]);
  });

  it('forgets the entries it is told to, and only those', () => {
    noteFrameEmitted(U, G, 1);
    noteFrameEmitted(U, G, 2);
    commitPersisted(U, snapshotEmitted(U));
    forgetSendRatchetEntries(U, [`${G}@1`]);

    expect(sendRatchetEntries(U).map((e) => e.key)).toEqual([`${G}@2`]);
  });

  it('forgets everything for a device identity that no longer exists', () => {
    noteFrameEmitted(U, G, 1);
    resetSendRatchetLedger(U);

    expect(sendRatchetEntries(U)).toEqual([]);
  });

  /**
   * A store that cannot be read is not a store that says zero - but it is the only answer available,
   * and it burns nothing, which is where this client stood before the ledger existed. What it must
   * NOT do is throw: that would take down an `init` over a counter.
   */
  it('treats an unreadable store as no information rather than an error', () => {
    localStorage.setItem(`mls_send_ledger_${U}`, 'not json at all');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(sendRatchetEntries(U)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
