import { GroupDrainAbandonedError, MailboxListingIncompleteError } from '$lib/mls-client';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';
import {
  CallGroupSessionEndedError,
  waitForCallGroupCurrent,
  type CallGroupCurrentDeps,
} from './callGroupCurrent';

/**
 * THE KEYS OF A CALL ANSWERED ON THE RING WAIT FOR ITS OWN GROUP AT THE SERVER'S EPOCH (calls.md,
 * "The answer joins on its own group"): one proof, re-read on events, every waiter removed when the
 * wait moves on or stops.
 */

/** Lets every settled promise's callbacks run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Status = 'error' | 'absent' | { groupId: string; activeEpoch?: number };

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
  };
  const release = vi.fn();
  const mls = {
    getEpoch: vi.fn(() => state.local),
    getLocalGroups: vi.fn(() => (state.held ? ['group-1'] : [])),
    getGroupServerStatus: vi.fn(async () => state.status),
    whenGroupFrameApplied: vi.fn((_g: string, signal?: AbortSignal) => frame.wait(signal)),
    whenGroupDrained: vi.fn((_g: string, signal?: AbortSignal) => pull.wait(signal)),
    isGroupDrained: vi.fn(() => state.drained),
    leadGroup: vi.fn(() => release),
  };
  const deps: CallGroupCurrentDeps = {
    mls: mls as unknown as CallGroupCurrentDeps['mls'],
    whenMlsReady: (signal) => (state.ready ? Promise.resolve() : mlsReady.wait(signal)),
    whenNextCatchUp: (signal) => catchUp.wait(signal),
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
    ready() {
      state.ready = true;
      mlsReady.fire();
    },
    applyFrame(epoch: number) {
      state.local = epoch;
      frame.fire();
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

describe('waitForCallGroupCurrent', () => {
  it('leads the drain while it waits, and only then', async () => {
    const w = world();
    const { outcome } = start(w);
    expect(w.mls.leadGroup).toHaveBeenCalledWith('group-1');
    w.ready();
    await flush();
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

  it('drained is not a proof: a drained group below the server is a WARN, and the wait goes on', async () => {
    const w = world({ local: 2, status: { groupId: 'group-1', activeEpoch: 4 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.state.drained = true;
    w.pull.fire();
    await flush();
    expect(outcome.proof).toBeNull();
    expect(w.warned('drained at epoch 2 while the server holds 4')).toBe(true);

    w.applyFrame(4);
    await flush();
    expect(outcome.proof).toBe('epoch-reached');
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

  it('a local epoch AHEAD of the server proves nothing: WARN, and the server is read again', async () => {
    const w = world({ local: 6, status: { groupId: 'group-1', activeEpoch: 5 } });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    expect(outcome.proof).toBeNull();
    expect(w.warned('AHEAD of the server (6 > 5)')).toBe(true);

    // The commit of ours is accepted: the server says 6 at the next read.
    w.state.status = { groupId: 'group-1', activeEpoch: 6 };
    w.frame.fire();
    await flush();
    expect(w.mls.getGroupServerStatus).toHaveBeenCalledTimes(2);
    expect(outcome.proof).toBe('epoch-reached');
  });

  it('a group this device does not hold is never proven by its epoch', async () => {
    const w = world({ local: 0, status: { groupId: 'group-1', activeEpoch: 0 }, held: false });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.state.drained = true;
    w.pull.fire();
    await flush();
    expect(outcome.proof).toBeNull();
  });

  it('an unreadable server epoch is said ONCE, read again on a pull or a connection, never on a frame', async () => {
    const w = world({ status: 'error', local: 3 });
    w.state.ready = true;
    const { outcome } = start(w);
    await flush();
    w.frame.fire();
    await flush();
    expect(w.mls.getGroupServerStatus).toHaveBeenCalledTimes(1);
    w.catchUp.fire();
    await flush();
    expect(w.mls.getGroupServerStatus).toHaveBeenCalledTimes(2);
    expect(w.lines.filter((l) => l.includes('could not be read (error)'))).toHaveLength(1);
    expect(outcome.proof).toBeNull();

    w.state.status = { groupId: 'group-1', activeEpoch: 3 };
    w.pull.fire();
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

  it('a stop before MLS is up removes the parked MLS-ready waiter', async () => {
    const w = world();
    const { wait } = start(w);
    expect(w.mlsReady.count).toBe(1);
    wait.stop();
    await expect(wait.mlsReady).rejects.toBeInstanceOf(CallSetupAbandonedError);
    expect(w.mlsReady.count).toBe(0);
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
