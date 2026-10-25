const persist = vi.hoisted(() => ({ scheduled: vi.fn() }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  scheduleOutboundMlsPersist: persist.scheduled,
}));

import { readConfirmedTree } from './confirmedTree';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { MlsPerGroupScheduler } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  isInEpochGap,
  markEpochGap,
  resetEpochGapRegistry,
} from '$lib/utils/chat/epochGapRegistry';
import {
  dischargeRefusedBacklog,
  noteUnackedFrame,
  refusedBacklogMark,
  resetUnackedFrames,
} from '$lib/mls-client/messagePipeline/unackedFrames';

/**
 * A GESTURE'S CONFIRMATION IS RUNG 1, AND IT KEEPS RUNG 1'S BOOKS (`replayAndRecord`, round 3 of
 * #2414). A tree caught up for a Remove or an Add moves the epoch like any replay: it is persisted,
 * a group the registry held in a gap is released, and a replay is never run past frames a refused
 * backlog is still bringing. And the lock it takes is the real, non-re-entrant one.
 */
const G = 'group-1';

/** A tree one commit behind the server, whose replay brings `bob` back. */
function behindByOne() {
  const state = { epoch: 4, tree: ['me:da'], ahead: 1 };
  const mls = createMlsServiceStub();
  vi.mocked(mls.getEpoch).mockImplementation(() => state.epoch);
  vi.mocked(mls.getGroupMemberIdentities).mockImplementation(async () => [...state.tree]);
  vi.mocked(mls.fetchCommitsSince).mockImplementation(async (_g, since) => ({
    commits: state.ahead > 0 ? [{ baseEpoch: since, proto: 'AQID' }] : [],
    activeEpoch: state.epoch + state.ahead,
    belowFloor: false,
  }));
  vi.mocked(mls.processIncomingMessage).mockImplementation(async () => {
    state.tree.push('bob:d1');
    state.epoch += 1;
    state.ahead -= 1;
    return null;
  });
  return { mls, state };
}

const holdsBob = (ids: readonly string[]) => ids.some((id) => id.startsWith('bob:'));

describe('readConfirmedTree - the bookkeeping of the replay it runs', () => {
  beforeEach(() => {
    resetEpochGapRegistry();
    resetUnackedFrames();
    persist.scheduled.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a group the registry holds in a gap, healed by the confirmation, is RELEASED and persisted', async () => {
    const { mls } = behindByOne();
    markEpochGap(G);

    const reading = await readConfirmedTree(mls, G, 'me', '[TEST]', holdsBob);

    expect(reading).toEqual({ status: 'read', identities: ['me:da', 'bob:d1'] });
    expect(isInEpochGap(G)).toBe(false);
    expect(persist.scheduled).toHaveBeenCalledTimes(1);
  });

  it('replays nothing past a refused backlog, ASKS FOR ITS PULL once, and replays after it', async () => {
    const { mls, state } = behindByOne();
    noteUnackedFrame(G, 'absent-conversation');

    const reading = await readConfirmedTree(mls, G, 'me', '[TEST]', holdsBob);

    expect(reading).toEqual({ status: 'unconfirmed' });
    expect(mls.processIncomingMessage).not.toHaveBeenCalled();
    expect(state.epoch).toBe(4);
    expect(persist.scheduled).not.toHaveBeenCalled();
    // The hold started the pull that ends it - a quiet conversation has no next frame to do so.
    expect(mls.notifyConversationAvailable).toHaveBeenCalledTimes(1);
    expect(mls.notifyConversationAvailable).toHaveBeenCalledWith(G);
    // One line for the hold, and not a `[GAP]` one.
    const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(said.filter((l) => l.includes('still queued'))).toHaveLength(1);
    expect(said.filter((l) => l.includes('[GAP]'))).toEqual([]);

    // That pull listed the whole mailbox: the backlog is discharged, and the next gesture replays.
    dischargeRefusedBacklog(refusedBacklogMark());
    await expect(readConfirmedTree(mls, G, 'me', '[TEST]', holdsBob)).resolves.toEqual({
      status: 'read',
      identities: ['me:da', 'bob:d1'],
    });
    expect(mls.notifyConversationAvailable).toHaveBeenCalledTimes(1);
  });

  it('THE REAL LOCK IS NOT RE-ENTRANT: a call from inside it waits for its own holder', async () => {
    const { mls } = behindByOne();
    const scheduler = new MlsPerGroupScheduler('web');
    vi.mocked(mls.runUnderMlsLock).mockImplementation((fn) => scheduler.runUnderMlsLock(fn));

    // Held by an outer caller, who then calls the confirmation itself.
    let release!: () => void;
    const outerHolds = new Promise<void>((r) => (release = r));
    const outer = scheduler.runUnderMlsLock(() => outerHolds);
    const nested = readConfirmedTree(mls, G, 'me', '[TEST]', holdsBob);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    // Not one read: it is queued behind the holder. Had the holder AWAITED it, neither would ever
    // finish - so a caller must never hold the lock (see the docblock).
    expect(mls.getGroupMemberIdentities).not.toHaveBeenCalled();

    release();
    await outer;
    await expect(nested).resolves.toEqual({
      status: 'read',
      identities: ['me:da', 'bob:d1'],
    });
  });
});
