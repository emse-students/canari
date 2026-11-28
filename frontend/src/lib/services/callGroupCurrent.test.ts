import { MailboxListingIncompleteError } from '$lib/mls-client';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';
import { waitForCallGroupCurrent, type CallGroupCurrentDeps } from './callGroupCurrent';

/**
 * THE JOIN OF A CALL ANSWERED ON THE RING WAITS FOR ITS OWN GROUP (calls.md, "The answer joins on its
 * own group"): the first of three proofs - the server's epoch reached, the group drained, the
 * session's catch-up - and the group leads the drain while it waits.
 */

/** Lets every settled promise's callbacks run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A world the test moves by hand: every proof is a promise it resolves, every epoch a field. */
function world(opts: { serverEpoch?: number | 'error'; localEpoch?: number; held?: boolean } = {}) {
  const lines: string[] = [];
  const mlsReady = Promise.withResolvers<void>();
  const caughtUp = Promise.withResolvers<void>();
  let drained = Promise.withResolvers<void>();
  let frameApplied = Promise.withResolvers<void>();
  const state = {
    local: opts.localEpoch ?? 3,
    held: opts.held ?? true,
    isDrained: false,
  };
  const release = vi.fn();
  const mls = {
    getEpoch: vi.fn(() => state.local),
    getLocalGroups: vi.fn(() => (state.held ? ['group-1'] : [])),
    getGroupServerStatus: vi.fn(async () =>
      opts.serverEpoch === 'error'
        ? ('error' as const)
        : { groupId: 'group-1', activeEpoch: opts.serverEpoch ?? 3 }
    ),
    whenGroupFrameApplied: vi.fn(() => frameApplied.promise),
    whenGroupDrained: vi.fn(() => drained.promise),
    isGroupDrained: vi.fn(() => state.isDrained),
    leadGroup: vi.fn(() => release),
  };
  const deps: CallGroupCurrentDeps = {
    mls: mls as unknown as CallGroupCurrentDeps['mls'],
    whenMlsReady: () => mlsReady.promise,
    whenSessionCaughtUp: () => caughtUp.promise,
    log: (l) => lines.push(l),
  };
  return {
    deps,
    mls,
    state,
    lines,
    release,
    mlsReady,
    caughtUp,
    /** One frame of the group applied: the epoch is read again. */
    applyFrame(epoch: number) {
      state.local = epoch;
      const done = frameApplied;
      frameApplied = Promise.withResolvers<void>();
      done.resolve();
    },
    drain() {
      state.isDrained = true;
      drained.resolve();
    },
    listingIncomplete() {
      const done = drained;
      drained = Promise.withResolvers<void>();
      done.reject(new MailboxListingIncompleteError('group-1', new Error('page refused')));
    },
  };
}

describe('waitForCallGroupCurrent', () => {
  it('the group leads the drain while the wait runs, and only then', async () => {
    const w = world();
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    expect(w.mls.leadGroup).toHaveBeenCalledWith('group-1');
    expect(w.release).not.toHaveBeenCalled();

    w.mlsReady.resolve();
    await expect(wait.proof).resolves.toBe('epoch-reached');
    expect(w.release).toHaveBeenCalledTimes(1);
  });

  it('a group at the server epoch is current once MLS is up - the catch-up is not waited for', async () => {
    const w = world({ serverEpoch: 5, localEpoch: 5 });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    let proof: string | null = null;
    void wait.proof.then((p) => (proof = p));
    await flush();
    // MLS is not up yet (a cold start still at the PIN): nothing is read, nothing proven.
    expect(proof).toBeNull();
    expect(w.mls.getGroupServerStatus).not.toHaveBeenCalled();

    w.mlsReady.resolve();
    await flush();
    expect(proof).toBe('epoch-reached');
  });

  it('a group behind is current at the frame that brings it to the server epoch, never before', async () => {
    const w = world({ serverEpoch: 7, localEpoch: 5 });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    let proof: string | null = null;
    void wait.proof.then((p) => (proof = p));
    w.mlsReady.resolve();
    await flush();
    expect(proof).toBeNull();

    w.applyFrame(6);
    await flush();
    expect(proof).toBeNull();

    w.applyFrame(7);
    await flush();
    expect(proof).toBe('epoch-reached');
  });

  it('a group this device does not hold is never proven by its epoch - the drain decides', async () => {
    const w = world({ serverEpoch: 0, localEpoch: 0, held: false });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    let proof: string | null = null;
    void wait.proof.then((p) => (proof = p));
    w.mlsReady.resolve();
    await flush();
    expect(proof).toBeNull();

    w.drain();
    await flush();
    expect(proof).toBe('group-drained');
  });

  it('a server epoch unknown leaves the proof to the drain', async () => {
    const w = world({ serverEpoch: 'error' });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    w.mlsReady.resolve();
    await flush();
    w.drain();
    await expect(wait.proof).resolves.toBe('group-drained');
    expect(w.lines.some((l) => l.includes("the server's epoch is unknown (error)"))).toBe(true);
  });

  it('a listing that ended incomplete defers the drained proof to the next complete one', async () => {
    const w = world({ serverEpoch: 'error' });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    let proof: string | null = null;
    void wait.proof.then((p) => (proof = p));
    w.listingIncomplete();
    await flush();
    expect(proof).toBeNull();

    w.drain();
    await flush();
    expect(proof).toBe('group-drained');
  });

  it("the session's catch-up proves it too, said at WARN when the group was not drained", async () => {
    const w = world({ serverEpoch: 'error' });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    w.caughtUp.resolve();
    await expect(wait.proof).resolves.toBe('session-caught-up');
    expect(w.lines.some((l) => l.includes('WARN group group-1 NOT proven current'))).toBe(true);
  });

  it('a catch-up over a drained group is no warning', async () => {
    const w = world({ serverEpoch: 'error' });
    w.state.isDrained = true;
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    w.caughtUp.resolve();
    await expect(wait.proof).resolves.toBe('session-caught-up');
    expect(w.lines.some((l) => l.includes('WARN'))).toBe(false);
  });

  it('a stop - the call ended - abandons the wait and releases the lead, once', async () => {
    const w = world({ serverEpoch: 9, localEpoch: 1 });
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    w.mlsReady.resolve();
    await flush();

    wait.stop();
    wait.stop();
    await expect(wait.proof).rejects.toBeInstanceOf(CallSetupAbandonedError);
    expect(w.release).toHaveBeenCalledTimes(1);

    // A frame after the stop reads nothing more.
    const reads = w.mls.getEpoch.mock.calls.length;
    w.applyFrame(9);
    await flush();
    expect(w.mls.getEpoch.mock.calls.length).toBe(reads);
  });

  it('an MLS client that ended under the wait fails it with its own error', async () => {
    const w = world({ serverEpoch: 9, localEpoch: 1 });
    w.mls.whenGroupFrameApplied.mockImplementation(() =>
      Promise.reject(new Error('client destroyed'))
    );
    const wait = waitForCallGroupCurrent(w.deps, 'group-1', 'call-1');
    w.mlsReady.resolve();
    await expect(wait.proof).rejects.toThrow('client destroyed');
    expect(w.release).toHaveBeenCalledTimes(1);
  });
});
