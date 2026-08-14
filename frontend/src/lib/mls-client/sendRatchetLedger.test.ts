import {
  MAX_BURN_GENERATIONS,
  commitPersisted,
  noteFrameEmitted,
  pendingSendGenerations,
  readSendRatchetLedgerForTest,
  resetSendRatchetLedger,
  snapshotEmitted,
} from './sendRatchetLedger';

/**
 * THE COUNTER THAT SURVIVES A LOST CHECKPOINT.
 *
 * Every case here is about the ONE decision this module makes - how far behind the restored snapshot
 * is - and about the direction it is allowed to be wrong in. Over-shooting costs a receiver a few
 * unused keys; under-shooting re-issues a spent generation and the peer refuses the frame. So the
 * ordering test below is not a detail of the API, it is the guarantee.
 */
const U = 'user-1';
const G = 'group-a';

describe('sendRatchetLedger', () => {
  beforeEach(() => localStorage.clear());

  it('reports nothing when nothing has been sent', () => {
    expect(pendingSendGenerations(U)).toEqual([]);
  });

  it('counts emitted frames per group, and keeps groups apart', () => {
    noteFrameEmitted(U, G);
    noteFrameEmitted(U, G);
    noteFrameEmitted(U, 'group-b');

    expect(pendingSendGenerations(U)).toEqual([
      { groupId: G, deficit: 2, clamped: false },
      { groupId: 'group-b', deficit: 1, clamped: false },
    ]);
  });

  it('keeps two users apart in one browser profile', () => {
    noteFrameEmitted(U, G);
    expect(pendingSendGenerations('user-2')).toEqual([]);
  });

  it('clears the deficit once a checkpoint declares those frames durable', () => {
    noteFrameEmitted(U, G);
    noteFrameEmitted(U, G);
    commitPersisted(U, snapshotEmitted(U));

    expect(pendingSendGenerations(U)).toEqual([]);
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
    noteFrameEmitted(U, G); // the frame the checkpoint will contain
    const inFlight = snapshotEmitted(U); // read before the write starts
    noteFrameEmitted(U, G); // a send while the disk is busy
    commitPersisted(U, inFlight); // committed after it lands

    expect(pendingSendGenerations(U)).toEqual([{ groupId: G, deficit: 1, clamped: false }]);
  });

  it('never lets a late checkpoint un-declare what a later one made durable', () => {
    noteFrameEmitted(U, G);
    const early = snapshotEmitted(U);
    noteFrameEmitted(U, G);
    commitPersisted(U, snapshotEmitted(U)); // the later checkpoint wins
    commitPersisted(U, early); // and the straggler must not undo it

    expect(pendingSendGenerations(U)).toEqual([]);
    expect(readSendRatchetLedgerForTest(U).persisted[G]).toBe(2);
  });

  /**
   * The background sender on Android/iOS persists inside its own batch and never touches this
   * ledger, so a device that sent while backgrounded comes back with a snapshot AHEAD of these
   * counters. There is nothing to repair in that direction, and a burn there would be pure waste.
   */
  it('reports nothing when the snapshot is AHEAD of the counters', () => {
    commitPersisted(U, { [G]: 5 });
    noteFrameEmitted(U, G);

    expect(pendingSendGenerations(U)).toEqual([]);
  });

  it('clamps an impossible deficit and SAYS it clamped', () => {
    commitPersisted(U, { [G]: 0 });
    localStorage.setItem(
      `mls_send_ledger_${U}`,
      JSON.stringify({ emitted: { [G]: MAX_BURN_GENERATIONS + 500 }, persisted: {} })
    );

    expect(pendingSendGenerations(U)).toEqual([
      { groupId: G, deficit: MAX_BURN_GENERATIONS, clamped: true },
    ]);
  });

  it('forgets everything for a device identity that no longer exists', () => {
    noteFrameEmitted(U, G);
    resetSendRatchetLedger(U);

    expect(pendingSendGenerations(U)).toEqual([]);
  });

  /**
   * A store that cannot be read is not a store that says zero - but it is the only answer available,
   * and it burns nothing, which is where this client stood before the ledger existed. What it must
   * NOT do is throw: that would take down an `init` over a counter.
   */
  it('treats an unreadable store as no information rather than an error', () => {
    localStorage.setItem(`mls_send_ledger_${U}`, 'not json at all');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(pendingSendGenerations(U)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
