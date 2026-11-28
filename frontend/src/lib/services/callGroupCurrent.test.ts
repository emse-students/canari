import { GroupDrainAbandonedError, MailboxListingIncompleteError } from '$lib/mls-client';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';
import {
  CallGroupAheadError,
  CallGroupClientReplacedError,
  CallGroupCommitUnresolvedError,
  CallGroupEpochUnknownError,
  CallGroupLogUnreachableError,
  CallGroupNotHeldError,
  CallGroupSessionEndedError,
  CallGroupStuckError,
  CallGroupUnlistedError,
  waitForCallGroupCurrent,
  type CallGroupCurrentDeps,
  type CallGroupMls,
} from './callGroupCurrent';

/**
 * THE KEYS OF A CALL ANSWERED ON THE RING WAIT FOR ITS OWN GROUP AT THE SERVER'S EPOCH (calls.md,
 * "The answer joins on its own group"): one proof, re-read on events armed BEFORE the facts are
 * read, a pull asked when the facts disagree and nothing is coming, offline a wait, a group behind
 * caught up from the commit log, a state held across a complete pull an answer, every waiter removed
 * when the wait moves on or stops.
 */

/** Lets every settled promise's callbacks run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Status = 'error' | 'absent' | { groupId: string; activeEpoch?: number };
type PullOutcome = 'listed' | 'incomplete';
type OwnCommit = 'none' | 'in-flight' | 'unresolved';
type Replay = 'healed' | 'held' | 'still-behind' | 'unreachable';
type Listing = 'listed' | 'pending' | 'unlisted';

/** One kind of waiter the test can fire, counting how many are still registered. */
function eventSource() {
  let waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  return {
    wait(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const w = { resolve, reject };
        waiters.push(w);
        signal?.addEventListener('abort', () => {
          waiters = waiters.filter((x) => x !== w);
          reject(signal.reason);
        });
      });
    },
    fire() {
      const fired = waiters;
      waiters = [];
      for (const w of fired) w.resolve();
    },
    fail(e: unknown) {
      const fired = waiters;
      waiters = [];
      for (const w of fired) w.reject(e);
    },
    get count() {
      return waiters.length;
    },
  };
}

/** A world the test moves by hand. */
function world(opts: { status?: Status; local?: number; held?: boolean } = {}) {
  const lines: string[] = [];
  const mlsReady = eventSource();
  const frame = eventSource();
  const pull = eventSource();
  const catchUp = eventSource();
  const state = {
    status: (opts.status ?? { groupId: 'group-1', activeEpoch: 3 }) as Status,
    local: opts.local ?? 3,
    held: opts.held ?? true,
    drained: false,
    ready: false,
    current: true,
    linkUp: true,
    /** The mailbox's listing on the link: a catch-up running by default. */
    listing: 'pending' as Listing,
    ownCommit: 'none' as OwnCommit,
    /** Held by a test while the commit-state read is in flight (an IPC). */
    ownCommitGate: null as Promise<void> | null,
    /** What the commit log's catch-up does to the world, and says. */
    onReplay: (): Replay => 'still-behind',
    /** What the settlement of an unresolved commit does to the world. */
    onSettle: (): void => {},
  };
  const release = vi.fn();
  /** The pulls the wait issued, each ended by `endPull`. */
  const pulls: Array<(outcome: PullOutcome) => void> = [];
  const waiting: Array<string | null> = [];
  const mls = {
    getEpoch: vi.fn(() => state.local),
    getLocalGroups: vi.fn(() => (state.held ? ['group-1'] : [])),
    getGroupServerStatus: vi.fn(async () => state.status),
    whenGroupFrameApplied: vi.fn((_g: string, signal?: AbortSignal) => frame.wait(signal)),
    whenGroupDrained: vi.fn((_g: string, signal?: AbortSignal) => pull.wait(signal)),
    groupDrainedNow: vi.fn(() => state.drained),
    isWsOpen: vi.fn(() => state.linkUp),
    mailboxListing: vi.fn(() => state.listing),
    leadGroup: vi.fn(() => release),
    pullForGroup: vi.fn(
      (_groupId: string) => new Promise<PullOutcome>((resolve) => pulls.push(resolve))
    ),
    ownCommitState: vi.fn(async () => {
      if (state.ownCommitGate) await state.ownCommitGate;
      return state.ownCommit;
    }),
    settleUnresolvedCommits: vi.fn(async (_groups?: string[]) => state.onSettle()),
    catchUpFromCommitLog: vi.fn(async (_groupId: string) => state.onReplay()),
  };
  const client = mls as unknown as CallGroupMls;
  const deps: CallGroupCurrentDeps = {
    mls: vi.fn(() => client),
    whenMlsReady: (signal) => (state.ready ? Promise.resolve() : mlsReady.wait(signal)),
    isReadyClient: (c) => state.current && c === client,
    whenNextCatchUp: (signal) => catchUp.wait(signal),
    onWaiting: (reason) => waiting.push(reason),
    log: (l) => lines.push(l),
  };
  return {
    deps,
    mls,
    state,
    lines,
    release,
    mlsReady,
    frame,
    pull,
    catchUp,
    waiting,
    ready() {
      state.ready = true;
      mlsReady.fire();
    },
    applyFrame(epoch: number) {
      state.local = epoch;
      frame.fire();
    },
    get pullsAsked() {
      return mls.pullForGroup.mock.calls.length;
    },
    /** Ends the oldest pull the wait issued, the world changed first by `change`. */
    endPull(change: () => void = () => {}, outcome: PullOutcome = 'listed') {
      change();
      pulls.shift()?.(outcome);
    },
    warned: (text: string) => lines.some((l) => l.includes('WARN') && l.includes(text)),
  };
}

/** Starts the wait and records its outcome. */
function start(w: ReturnType<typeof world>) {
  const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
  const outcome: { proof: string | null; error: unknown } = { proof: null, error: null };
  wait.proof.then(
    (p) => (outcome.proof = p),
    (e: unknown) => (outcome.error = e)
  );
  return { wait, outcome };
}

describe('waitForCallGroupCurrent - the proof', () => {
  it('leads the drain once MLS is up, and only until the proof', async () => {
    const w = world();
    const { outcome } = start(w);
    expect(w.mls.leadGroup).not.toHaveBeenCalled();
    w.ready();
    await flush();
    expect(w.mls.leadGroup).toHaveBeenCalledWith('group-1');
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.release).toHaveBeenCalledTimes(1);
  });

  it('reads nothing before MLS is up, then proves a group at the server epoch at once', async () => {
    const w = world({ local: 5, status: { groupId: 'group-1', activeEpoch: 5 } });
    const { wait, outcome } = start(w);
    await flush();
    expect(outcome.proof).toBeNull();
    expect(w.mls.getGroupServerStatus).not.toHaveBeenCalled();
    w.ready();
    await expect(wait.mlsReady).resolves.toBeUndefined();
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a caught-up session is no proof: local below the server waits, whatever the catch-up says', async () => {
    const w = world({ local: 5, status: { groupId: 'group-1', activeEpoch: 7 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.catchUp.fire();
    await flush();
    expect(outcome.proof).toBeNull();

    w.applyFrame(6);
    await flush();
    expect(outcome.proof).toBeNull();
    w.applyFrame(7);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a server that sends no epoch: a HELD group drained on this link is the proof', async () => {
    const w = world({ status: { groupId: 'group-1' } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    expect(outcome.proof).toBeNull();
    w.state.drained = true;
    w.pull.fire();
    await flush();
    expect(outcome.proof).toBe('drained-no-server-epoch');
  });

  it('a local epoch AHEAD of the server proves nothing: WARN, and the server is read again', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    expect(outcome.proof).toBeNull();
    expect(w.warned('AHEAD of the server (6 > 5)')).toBe(true);

    w.state.status = { groupId: 'group-1', activeEpoch: 6 };
    w.frame.fire();
    await flush();
    expect(w.mls.getGroupServerStatus).toHaveBeenCalledTimes(2);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('logs the epoch only when it changes', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 9 } });
    w.state.ready = true;
    start(w);
    await flush();
    w.frame.fire();
    await flush();
    w.frame.fire();
    await flush();
    w.applyFrame(2);
    await flush();
    expect(w.lines.filter((l) => l.includes("the server's is 9"))).toHaveLength(2);
  });

  it('a listing that FAILED with nothing after it is nothing coming: the wait asks its own pull', async () => {
    // The catch-up's pull refused a page: not drained, and no pull running or owed. Waiting for a
    // frame here would wait until the caller hung up.
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    w.state.listing = 'unlisted';
    w.pull.fail(new MailboxListingIncompleteError('group-1', new Error('page refused')));
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull(() => {
      w.state.listing = 'listed';
      w.state.local = 2;
    });
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('never listed on this link with nothing pending, from the start: a pull is asked at once', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    w.state.listing = 'unlisted';
    start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    expect(w.waiting).toEqual([]);
  });
});

describe('waitForCallGroupCurrent - a pull asked, and the answers', () => {
  it('drained below the server asks a pull, and the frames it brings prove it', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    expect(w.mls.pullForGroup).toHaveBeenCalledWith('group-1');
    w.endPull(() => (w.state.local = 4));
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('behind across a complete pull: the COMMIT LOG holds what the mailbox lacks, and its replay proves - nothing handed on', async () => {
    // The post-commit fan-out to this device failed (best effort): the pull lists nothing, the
    // server's row reads 4, and the commit log has the commits.
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.onReplay = () => {
      w.state.local = 4;
      return 'healed';
    };
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();
    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledTimes(1);
    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledWith('group-1');
    expect(outcome.proof).toBe('epoch-reached');
    expect(outcome.error).toBeNull();
  });

  it('STUCK only when the commit log cannot close the gap: typed, ERROR, with both epochs', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();

    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeInstanceOf(CallGroupStuckError);
    const stuck = outcome.error as CallGroupStuckError;
    expect([stuck.localEpoch, stuck.serverEpoch]).toEqual([2, 4]);
    expect(w.pullsAsked).toBe(1);
    expect(w.release).toHaveBeenCalledTimes(1);
    expect(
      w.lines.some((l) => l.includes('ERROR call=call-1') && l.includes('local=2 server=4'))
    ).toBe(true);
  });

  it('a replay held behind refused frames asks a pull of its own; held again after it, STUCK', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.onReplay = () => 'held';
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();
    expect(outcome.error).toBeNull();
    expect(w.pullsAsked).toBe(2);
    w.endPull();
    await flush();
    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledTimes(2);
    expect(outcome.error).toBeInstanceOf(CallGroupStuckError);
  });

  it('a commit of ours IN FLIGHT is something coming: no pull, no verdict, its settling wakes the wait', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = 'in-flight';
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    expect(w.mls.settleUnresolvedCommits).not.toHaveBeenCalled();
    expect(outcome.error).toBeNull();

    // mergeAccepted: the commit settles and the epoch reaches the server's.
    w.state.ownCommit = 'none';
    w.applyFrame(3);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.mls.catchUpFromCommitLog).not.toHaveBeenCalled();
  });

  it('a commit of ours UNRESOLVED is settled by the wait once; its settlement proves', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = 'unresolved';
    w.state.onSettle = () => {
      w.state.ownCommit = 'none';
      w.state.local = 3;
    };
    const { outcome } = start(w);
    await flush();
    expect(w.mls.settleUnresolvedCommits).toHaveBeenCalledWith(['group-1']);
    expect(w.pullsAsked).toBe(0);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('UNRESOLVED with nobody settling it ENDS: typed, WARN, never a hang', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = 'unresolved';
    const { outcome } = start(w);
    await flush();
    expect(w.mls.settleUnresolvedCommits).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeInstanceOf(CallGroupCommitUnresolvedError);
    expect(w.lines.some((l) => l.includes('WARN call=call-1'))).toBe(true);
  });

  it('ARM, THEN CHECK: a frame applied while the commit state is read is never missed', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    let openGate: () => void = () => {};
    w.state.ownCommitGate = new Promise<void>((r) => (openGate = r));
    const { outcome } = start(w);
    await flush();
    expect(w.mls.ownCommitState).toHaveBeenCalledTimes(1);
    // The group's last frame lands DURING the read - its event fires before any verdict.
    w.applyFrame(3);
    w.state.ownCommitGate = null;
    openGate();
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a pull that moved the facts is no answer: the new state asks its own pull', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => (w.state.local = 2));
    await flush();
    expect(outcome.error).toBeNull();
    expect(w.pullsAsked).toBe(2);
    w.endPull(() => (w.state.local = 4));
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('ahead and drained asks a pull; the server caught up after it proves', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull(() => (w.state.status = { groupId: 'group-1', activeEpoch: 6 }));
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('ahead across a complete pull with no commit of ours is an answer: typed, ERROR, nothing handed on', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupAheadError);
    expect(w.mls.catchUpFromCommitLog).not.toHaveBeenCalled();
    expect(w.lines.some((l) => l.includes('ERROR call=call-1'))).toBe(true);
  });

  it('ahead with a commit of ours in flight waits for it: no pull, its settling proves', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = 'in-flight';
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    w.state.ownCommit = 'none';
    w.state.status = { groupId: 'group-1', activeEpoch: 6 };
    w.frame.fire();
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a group this device does not hold: after a complete pull, an answer - never repaired', async () => {
    const w = world({ local: 0, status: { groupId: 'group-1', activeEpoch: 0 }, held: false });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.state.drained = true;
    w.pull.fire();
    await flush();
    expect(outcome.proof).toBeNull();
    expect(w.pullsAsked).toBe(1);
    w.endPull();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupNotHeldError);
    expect(w.mls.catchUpFromCommitLog).not.toHaveBeenCalled();
  });

  it('no server epoch and the group not held: an answer after a complete pull, never a silent wait', async () => {
    const w = world({ status: { groupId: 'group-1' }, held: false });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupNotHeldError);
  });

  it('an unreadable server epoch is said ONCE and asks a pull; readable after it, it proves', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull(() => (w.state.status = { groupId: 'group-1', activeEpoch: 3 }));
    await flush();
    expect(w.lines.filter((l) => l.includes('could not be read (error)'))).toHaveLength(1);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('unread and drained never hangs: unread across a complete pull is its own answer, never stuck', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupEpochUnknownError);
    expect((outcome.error as CallGroupEpochUnknownError).serverEpoch).toBeNull();
    expect((outcome.error as CallGroupEpochUnknownError).why).toContain('still unreadable (error)');
    expect(w.mls.catchUpFromCommitLog).not.toHaveBeenCalled();
    expect(w.lines.some((l) => l.includes('WARN call=call-1'))).toBe(true);
  });

  it('an incomplete pull, the link up, a pull still owed: said at WARN, asked again after its end', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(outcome.error).toBeNull();
    expect(w.pullsAsked).toBe(1);
    expect(w.warned('could not list the mailbox, the link up (1 in a row)')).toBe(true);
    w.pull.fire();
    await flush();
    expect(w.pullsAsked).toBe(2);
    w.endPull(() => (w.state.status = { groupId: 'group-1', activeEpoch: 3 }));
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('an incomplete pull with NOTHING pending after it is asked again at once - two end the wait', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    w.state.listing = 'unlisted';
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(w.pullsAsked).toBe(2);
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupUnlistedError);
  });

  it('two incomplete pulls in a row, the link up, end the wait, typed and visible', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    w.catchUp.fire();
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupUnlistedError);
  });
});

describe('waitForCallGroupCurrent - offline is a wait, never a failure', () => {
  it('offline: nothing is asked, the screen says network, and no pull counts', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    w.state.linkUp = false;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    expect(w.waiting).toEqual(['network']);
    // Pulls that end while the link is down wake the wait and change nothing.
    w.pull.fire();
    await flush();
    w.pull.fire();
    await flush();
    expect(w.pullsAsked).toBe(0);
    expect(outcome.error).toBeNull();
  });

  it('the socket back up and caught up: the server read again, and it proves', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    w.state.linkUp = false;
    const { outcome } = start(w);
    await flush();
    w.state.linkUp = true;
    w.state.status = { groupId: 'group-1', activeEpoch: 3 };
    w.catchUp.fire();
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.waiting).toEqual(['network', null]);
  });

  it('a pull LOST TO A LINK DROP is asked again after the reconnect, even when the reconnect changed nothing', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(1);
    w.endPull(() => {
      w.state.linkUp = false;
      w.state.drained = false;
      w.state.listing = 'unlisted';
    }, 'incomplete');
    await flush();
    expect(w.waiting).toEqual(['network']);

    // The reconnect lists the mailbox and brings nothing: the same state.
    w.state.linkUp = true;
    w.state.drained = true;
    w.state.listing = 'listed';
    w.catchUp.fire();
    await flush();
    expect(w.pullsAsked).toBe(2);
    w.endPull();
    await flush();
    // The listed state is judged: the commit log, then the answer - no frame rescued it.
    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeInstanceOf(CallGroupStuckError);
  });

  it('a settlement the link dropped under is no answer: offline, then asked again', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = 'unresolved';
    w.state.onSettle = () => {
      w.state.linkUp = false;
    };
    const { outcome } = start(w);
    await flush();
    expect(w.mls.settleUnresolvedCommits).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeNull();
    expect(w.waiting).toEqual(['network']);

    w.state.linkUp = true;
    w.state.onSettle = () => {
      w.state.ownCommit = 'none';
      w.state.local = 3;
    };
    w.catchUp.fire();
    await flush();
    expect(w.mls.settleUnresolvedCommits).toHaveBeenCalledTimes(2);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a commit log that could not be read, the link down: a wait, then the log asked again', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.onReplay = () => {
      w.state.linkUp = false;
      w.state.drained = false;
      return 'unreachable';
    };
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();
    expect(outcome.error).toBeNull();
    expect(w.waiting).toEqual(['network']);

    w.state.linkUp = true;
    w.state.drained = true;
    w.state.onReplay = () => {
      w.state.local = 4;
      return 'healed';
    };
    w.catchUp.fire();
    await flush();
    expect(w.pullsAsked).toBe(2);
    w.endPull();
    await flush();
    expect(w.mls.catchUpFromCommitLog).toHaveBeenCalledTimes(2);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a commit log that could not be read, the link up: WARN, typed - never behind', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.onReplay = () => 'unreachable';
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupLogUnreachableError);
    expect(outcome.error).not.toBeInstanceOf(CallGroupStuckError);
    expect(w.lines.some((l) => l.includes('WARN call=call-1'))).toBe(true);
  });

  it('a pull that came back incomplete because the link went down counts for nothing', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {
      w.state.linkUp = false;
      w.state.drained = false;
    }, 'incomplete');
    await flush();
    expect(w.warned('could not list the mailbox, the link up')).toBe(false);
    expect(w.waiting).toEqual(['network']);
    w.state.linkUp = true;
    w.applyFrame(2);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(outcome.error).toBeNull();
  });
});

describe('waitForCallGroupCurrent - what the screen is told', () => {
  it('the conversation while the group catches up on its own frames', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    start(w);
    await flush();
    expect(w.waiting).toEqual(['conversation']);
  });
});

describe('waitForCallGroupCurrent - stops, sessions and clients', () => {
  it('a stopped wait leaves no waiter behind, and incomplete pulls after it wake nothing', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 9 } });
    w.state.ready = true;
    const { wait, outcome } = start(w);
    await flush();
    expect(w.frame.count + w.pull.count + w.catchUp.count).toBe(3);

    wait.stop();
    wait.stop();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallSetupAbandonedError);
    expect(w.release).toHaveBeenCalledTimes(1);
    expect(w.frame.count + w.pull.count + w.catchUp.count).toBe(0);

    const lines = w.lines.length;
    w.pull.fail(new MailboxListingIncompleteError('group-1', new Error('page refused')));
    w.frame.fire();
    await flush();
    expect(w.lines.length).toBe(lines);
    expect(w.mls.getGroupServerStatus).toHaveBeenCalledTimes(1);
  });

  it('a released lead keeps the wait: the proof still lands, the lead released once', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    const { wait, outcome } = start(w);
    await flush();
    wait.releaseLead();
    wait.releaseLead();
    expect(w.release).toHaveBeenCalledTimes(1);

    w.applyFrame(2);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.release).toHaveBeenCalledTimes(1);
  });

  it('a stop before MLS is up removes the parked MLS-ready waiter', async () => {
    const w = world();
    const { wait } = start(w);
    expect(w.mlsReady.count).toBe(1);
    wait.stop();
    await expect(wait.mlsReady).rejects.toBeInstanceOf(CallSetupAbandonedError);
    expect(w.mlsReady.count).toBe(0);
  });

  it('a wait stopped before MLS is up leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const w = world();
      const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
      wait.stop();
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reads the CURRENT client only once MLS is up, and on that one', async () => {
    const w = world();
    const { outcome } = start(w);
    expect(w.deps.mls).not.toHaveBeenCalled();
    w.ready();
    await flush();
    expect(w.deps.mls).toHaveBeenCalledTimes(1);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a current client MLS is not ready on ends typed, leading and reading nothing', async () => {
    const w = world();
    w.state.current = false;
    const { outcome } = start(w);
    w.ready();
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupClientReplacedError);
    expect(outcome.error).toBeInstanceOf(CallGroupSessionEndedError);
    expect(w.mls.leadGroup).not.toHaveBeenCalled();
    expect(w.mls.getGroupServerStatus).not.toHaveBeenCalled();
  });

  it('the client destroyed under it is a session end, typed - never a call failure', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 9 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.frame.fail(new GroupDrainAbandonedError('group-1'));
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupSessionEndedError);
    expect(w.release).toHaveBeenCalledTimes(1);
  });
});
