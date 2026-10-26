// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { closeMlsDb } from '$lib/utils/hex';
import {
  MAX_BURN_GENERATIONS,
  forgetSendRatchetEntries,
  noteFrameEmitted,
  raiseEmittedCounts,
  readEmitted,
  resetSendRatchetLedger,
  sendRatchetDebt,
  sendRatchetEntries,
  stagePersisted,
  type SendRatchetDebt,
} from './sendRatchetLedger';
import {
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  STATE_LEDGER,
  takeStagedStateLedgers,
} from './stateLedgers';

/**
 * THE COUNTER THAT SURVIVES A LOST CHECKPOINT.
 *
 * Every case here is about the ONE decision this module makes - how far behind the restored state
 * is, and in WHICH EPOCH - and about the direction it is allowed to be wrong in. Over-shooting costs
 * a receiver a few unused keys; under-shooting re-issues a spent generation and the peer refuses the
 * frame. So the ordering test below is not a detail of the API, it is the guarantee.
 *
 * `emitted` is in IndexedDB (here `fake-indexeddb`), `persisted` in the state ledgers - hydrated as
 * the opened state would hand them over.
 */
const U = 'user-1';
const G = 'group-a';

/** Every entry's debt against a state restored at `restored` (one epoch for every group here). */
async function debts(
  restored: number
): Promise<Array<{ groupId: string; epoch: number | null } & SendRatchetDebt>> {
  return (await sendRatchetEntries(U)).map((e) => ({
    groupId: e.groupId,
    epoch: e.epoch,
    ...sendRatchetDebt(e, restored),
  }));
}

/** A checkpoint as `persistCheckpoint` takes it: `emitted` read before, `persisted` staged. */
async function checkpointSnapshot(): Promise<Record<string, number>> {
  return readEmitted(U);
}

describe('sendRatchetLedger', () => {
  beforeEach(async () => {
    await closeMlsDb();
    globalThis.indexedDB = new IDBFactory();
    resetStateLedgersForTests();
    hydrateStateLedgers(U, {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports nothing when nothing has been sent', async () => {
    expect(await sendRatchetEntries(U)).toEqual([]);
  });

  it('counts emitted frames per group AND epoch, and keeps both apart', async () => {
    await noteFrameEmitted(U, G, 4);
    await noteFrameEmitted(U, G, 4);
    await noteFrameEmitted(U, G, 5);
    await noteFrameEmitted(U, 'group-b', 4);

    expect(await debts(4)).toEqual([
      { groupId: G, epoch: 4, kind: 'burn-now', count: 2, clamped: false },
      { groupId: G, epoch: 5, kind: 'on-arrival', count: 1, clamped: false },
      { groupId: 'group-b', epoch: 4, kind: 'burn-now', count: 1, clamped: false },
    ]);
  });

  it('keeps two users apart in one browser profile', async () => {
    await noteFrameEmitted(U, G, 1);
    hydrateStateLedgers('user-2', {});
    expect(await sendRatchetEntries('user-2')).toEqual([]);
  });

  /**
   * THE COUNT IS ON DISK WHEN THE CALL RESOLVES (KILL-2, 2026-10-26): a second connection - the
   * relaunched browser - reads it back. `localStorage` resolved at once and reached the disk seconds
   * later, so a frame could leave with no durable trace of it.
   */
  it('has committed the count by the time the send is told to post', async () => {
    await noteFrameEmitted(U, G, 1);
    await closeMlsDb(); // the next reader opens the database afresh, as a relaunch would
    expect(await readEmitted(U)).toEqual({ [`${G}@1`]: 1 });
  });

  it('refuses the post, typed, when the count cannot commit', async () => {
    await closeMlsDb();
    const broken = new IDBFactory();
    broken.open = () => {
      throw new DOMException('Internal error', 'UnknownError');
    };
    globalThis.indexedDB = broken;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(noteFrameEmitted(U, G, 1)).rejects.toMatchObject({
      name: 'SendCountNotDurableError',
    });
  });

  it('clears the deficit once a checkpoint stages those frames into the state', async () => {
    await noteFrameEmitted(U, G, 1);
    await noteFrameEmitted(U, G, 1);
    stagePersisted(U, await checkpointSnapshot());

    expect(await debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
    expect(takeStagedStateLedgers(U)).toEqual({
      [STATE_LEDGER.sendPersisted]: JSON.stringify({ [`${G}@1`]: 2 }),
    });
  });

  /**
   * THE ORDER IS THE GUARANTEE, AND THIS IS THE CASE THAT PINS IT.
   *
   * A checkpoint reads `emitted` BEFORE its export. A send after that read is not in the count it
   * stages, so it stays owed - one generation too many burnt if the export held it, the defect
   * avoided if it did not.
   */
  it('counts a send that lands DURING a checkpoint as unpersisted', async () => {
    await noteFrameEmitted(U, G, 1); // the frame the checkpoint will contain
    const inFlight = await checkpointSnapshot(); // read before the export
    await noteFrameEmitted(U, G, 1); // a send while the checkpoint runs
    stagePersisted(U, inFlight);

    expect(await debts(1)).toEqual([
      { groupId: G, epoch: 1, kind: 'burn-now', count: 1, clamped: false },
    ]);
  });

  it('never lets a late checkpoint un-declare what a later one made durable', async () => {
    await noteFrameEmitted(U, G, 1);
    const early = await checkpointSnapshot();
    await noteFrameEmitted(U, G, 1);
    stagePersisted(U, await checkpointSnapshot()); // the later checkpoint wins
    stagePersisted(U, early); // and the straggler must not undo it

    expect(await debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
    expect(JSON.parse(readStateLedger(U, STATE_LEDGER.sendPersisted)!)[`${G}@1`]).toBe(2);
  });

  /**
   * THE EPOCH IS WHAT DECIDES WHERE A COUNT IS OWED (2026-10-23). A state restored at 4 holds epoch
   * 4's ratchet as the last checkpoint left it, and nothing of epoch 5: frames sent at 5 after a merge
   * that checkpoint does not hold are ALL owed, and owed at 5 - a merge restarts 5 at generation 0.
   * Frames at 3 are past: no ratchet will send there again.
   */
  it('places each count in its epoch: the restored one, one ahead of it, one behind it', async () => {
    await noteFrameEmitted(U, G, 3);
    await noteFrameEmitted(U, G, 4);
    await noteFrameEmitted(U, G, 5);
    await noteFrameEmitted(U, G, 5);
    // A checkpoint that saw epoch 5's first frame cannot be the one restored at 4, but a count it
    // staged must still not shrink what epoch 5 owes a state that never reached it.
    stagePersisted(U, { [`${G}@5`]: 1 });

    expect(await debts(4)).toEqual([
      { groupId: G, epoch: 3, kind: 'spent' },
      { groupId: G, epoch: 4, kind: 'burn-now', count: 1, clamped: false },
      { groupId: G, epoch: 5, kind: 'on-arrival', count: 2, clamped: false },
    ]);
  });

  /**
   * An entry written before epochs were kept (`docs/wiki/legacy-compatibility.md`) is counted the
   * way the client that wrote it counted: against the epoch the state is restored at.
   */
  it('reads a pre-epoch entry against the restored epoch, as its writer did', async () => {
    await raiseEmittedCounts(U, { [G]: 3 });
    stagePersisted(U, { [G]: 1 });

    expect(await debts(7)).toEqual([
      { groupId: G, epoch: null, kind: 'burn-now', count: 2, clamped: false },
    ]);
  });

  /**
   * The background sender on Android/iOS persists inside its own batch and never touches this
   * ledger, so a device that sent while backgrounded comes back with a state AHEAD of these
   * counters. There is nothing to repair in that direction, and a burn there would be pure waste.
   */
  it('reports nothing when the state is AHEAD of the counters', async () => {
    stagePersisted(U, { [`${G}@1`]: 5 });
    await noteFrameEmitted(U, G, 1);

    expect(await debts(1)).toEqual([{ groupId: G, epoch: 1, kind: 'settled' }]);
  });

  it('clamps an impossible deficit and SAYS it clamped', async () => {
    await raiseEmittedCounts(U, { [`${G}@1`]: MAX_BURN_GENERATIONS + 500 });

    expect(await debts(1)).toEqual([
      { groupId: G, epoch: 1, kind: 'burn-now', count: MAX_BURN_GENERATIONS, clamped: true },
    ]);
  });

  it('never lowers a count it is asked to raise', async () => {
    await noteFrameEmitted(U, G, 1);
    await noteFrameEmitted(U, G, 1);
    await raiseEmittedCounts(U, { [`${G}@1`]: 1, [`${G}@2`]: 4 });

    expect(await readEmitted(U)).toEqual({ [`${G}@1`]: 2, [`${G}@2`]: 4 });
  });

  it('forgets the entries it is told to, from both stores, and only those', async () => {
    await noteFrameEmitted(U, G, 1);
    await noteFrameEmitted(U, G, 2);
    stagePersisted(U, await checkpointSnapshot());
    await forgetSendRatchetEntries(U, [`${G}@1`]);

    expect((await sendRatchetEntries(U)).map((e) => e.key)).toEqual([`${G}@2`]);
    expect(JSON.parse(readStateLedger(U, STATE_LEDGER.sendPersisted)!)).toEqual({ [`${G}@2`]: 1 });
  });

  it('forgets everything for a device identity that no longer exists', async () => {
    await noteFrameEmitted(U, G, 1);
    stagePersisted(U, await checkpointSnapshot());
    await resetSendRatchetLedger(U);

    expect(await sendRatchetEntries(U)).toEqual([]);
    expect(readStateLedger(U, STATE_LEDGER.sendPersisted)).toBeUndefined();
  });

  /**
   * A `persisted` value that cannot be read is not one that says zero - but it is the only answer
   * available, and it over-burns, which is free. What it must NOT do is throw: that would take down
   * an `init` over a counter.
   */
  it('treats an unreadable persisted ledger as nothing persisted rather than an error', async () => {
    hydrateStateLedgers(U, { [STATE_LEDGER.sendPersisted]: 'not json at all' });
    await noteFrameEmitted(U, G, 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await debts(1)).toEqual([
      { groupId: G, epoch: 1, kind: 'burn-now', count: 1, clamped: false },
    ]);
    expect(warn).toHaveBeenCalled();
  });
});
