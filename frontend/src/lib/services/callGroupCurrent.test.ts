import { GroupDrainAbandonedError, MailboxListingIncompleteError } from '$lib/mls-client';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';
import {
  CallGroupAheadError,
  CallGroupClientReplacedError,
  CallGroupEpochUnknownError,
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
 * "The answer joins on its own group"): one proof, re-read on events, a pull asked when the facts
 * disagree and nothing is coming, a state held across a complete pull an answer, every waiter
 * removed when the wait moves on or stops.
 */

/** Lets every settled promise's callbacks run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Status = 'error' | 'absent' | { groupId: string; activeEpoch?: number };
type PullOutcome = 'listed' | 'incomplete';

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
    ownCommit: false,
  };
  const release = vi.fn();
  /** The pulls the wait issued, each ended by `endPull`. */
  const pulls: Array<(outcome: PullOutcome) => void> = [];
  const waiting: Array<string | null> = [];
  const handed: string[] = [];
  const mls = {
    getEpoch: vi.fn(() => state.local),
    getLocalGroups: vi.fn(() => (state.held ? ['group-1'] : [])),
    getGroupServerStatus: vi.fn(async () => state.status),
    whenGroupFrameApplied: vi.fn((_g: string, signal?: AbortSignal) => frame.wait(signal)),
    whenGroupDrained: vi.fn((_g: string, signal?: AbortSignal) => pull.wait(signal)),
    isGroupDrained: vi.fn(() => state.drained),
    leadGroup: vi.fn(() => release),
    pullForGroup: vi.fn(
      (_groupId: string) => new Promise<PullOutcome>((resolve) => pulls.push(resolve))
    ),
    ownCommitPending: vi.fn(async () => state.ownCommit),
  };
  const client = mls as unknown as CallGroupMls;
  const deps: CallGroupCurrentDeps = {
    mls: vi.fn(() => client),
    whenMlsReady: (signal) => (state.ready ? Promise.resolve() : mlsReady.wait(signal)),
    isReadyClient: (c) => state.current && c === client,
    whenNextCatchUp: (signal) => catchUp.wait(signal),
    onWaiting: (reason) => waiting.push(reason),
    handToGapLadder: (groupId) => handed.push(groupId),
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
    handed,
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

  it('an incomplete listing with the server epoch known keeps waiting for the epoch', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.pull.fail(new MailboxListingIncompleteError('group-1', new Error('page refused')));
    await flush();
    expect(outcome.proof).toBeNull();
    expect(outcome.error).toBeNull();
    w.applyFrame(2);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
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

  it('STUCK: behind across a complete pull, nothing of ours coming, handed to the gap ladder once', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    w.endPull();
    await flush();

    expect(outcome.error).toBeInstanceOf(CallGroupStuckError);
    const stuck = outcome.error as CallGroupStuckError;
    expect([stuck.localEpoch, stuck.serverEpoch]).toEqual([2, 4]);
    expect(w.pullsAsked).toBe(1);
    expect(w.release).toHaveBeenCalledTimes(1);
    expect(w.handed).toEqual(['group-1']);
    expect(
      w.lines.some((l) => l.includes('ERROR call=call-1') && l.includes('local=2 server=4'))
    ).toBe(true);
    expect(w.lines.some((l) => l.includes('of call=call-1 handed to the epoch-gap ladder'))).toBe(
      true
    );
  });

  it('a commit of ours staged or unresolved is something coming: no pull, no verdict, its settling wakes the wait', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 3 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    expect(outcome.error).toBeNull();

    // mergeAccepted: the commit settles and the epoch reaches the server's.
    w.state.ownCommit = false;
    w.applyFrame(3);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.handed).toEqual([]);
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
    expect(w.handed).toEqual([]);
    expect(w.lines.some((l) => l.includes('ERROR call=call-1'))).toBe(true);
  });

  it('ahead with a commit of ours in flight waits for it: no pull, its settling proves', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    w.state.drained = true;
    w.state.ownCommit = true;
    const { outcome } = start(w);
    await flush();
    expect(w.pullsAsked).toBe(0);
    w.state.ownCommit = false;
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
    expect(w.handed).toEqual([]);
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
    expect(w.handed).toEqual([]);
    expect(w.lines.some((l) => l.includes('WARN call=call-1'))).toBe(true);
  });

  it('an incomplete pull is said at WARN and allows ONE more ask; readable then, it proves', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(outcome.error).toBeNull();
    expect(w.pullsAsked).toBe(2);
    expect(w.warned('could not list the mailbox (1 in a row)')).toBe(true);
    w.endPull(() => (w.state.status = { groupId: 'group-1', activeEpoch: 3 }));
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('two incomplete pulls in a row end the wait, typed and visible', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    w.endPull(() => {}, 'incomplete');
    await flush();
    expect(outcome.error).toBeInstanceOf(CallGroupUnlistedError);
    expect(w.handed).toEqual([]);
  });
});

describe('waitForCallGroupCurrent - what the screen is told', () => {
  it('the network after an incomplete pull, nothing once proven', async () => {
    const w = world({ local: 1, status: { groupId: 'group-1', activeEpoch: 2 } });
    w.state.ready = true;
    w.state.drained = true;
    const { outcome } = start(w);
    await flush();
    // The link dropped: the pull could not list, and the group is no longer drained on it.
    w.endPull(() => (w.state.drained = false), 'incomplete');
    await flush();
    expect(w.waiting).toEqual(['network']);
    w.applyFrame(2);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
    expect(w.waiting).toEqual(['network', null]);
  });

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
