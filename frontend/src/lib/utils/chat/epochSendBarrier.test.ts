import {
  isEpochAdvanceInFlight,
  resetEpochSendBarrier,
  runAsEpochAdvance,
  runAsEpochSend,
} from './epochSendBarrier';

/** A promise a test resolves by hand, so an ordering is asserted rather than raced. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The ordering that lost twelve messages on production DM `7da231f8` (2026-09-02): an application
 * frame encrypted at epoch N and posted after this device's own commit had already moved the group
 * past it. Two further commits then dropped the secrets for N, and the frame became undecryptable
 * for every recipient, for good.
 *
 * These cases pin the ordering itself, not the MLS side of it: what must be impossible is a
 * `post` appearing after an `advance` that an `encrypt` preceded.
 */
describe('epochSendBarrier - a send and a local epoch advance never straddle', () => {
  beforeEach(() => resetEpochSendBarrier());

  it('holds a send back until the advance in flight has merged', async () => {
    const trace: string[] = [];
    const merge = gate();

    const advance = runAsEpochAdvance('g', async () => {
      trace.push('advance:start');
      await merge.promise;
      trace.push('advance:merge');
    });

    const send = runAsEpochSend('g', async () => {
      // The encrypt is what picks the epoch, so it is the step that must not happen early.
      trace.push('encrypt');
      trace.push('post');
    });

    // Nothing of the send may have run yet, however many microtasks pass.
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(['advance:start']);

    merge.open();
    await Promise.all([advance, send]);

    expect(trace).toEqual(['advance:start', 'advance:merge', 'encrypt', 'post']);
  });

  it('holds an advance back until a frame already encrypted has reached the wire', async () => {
    const trace: string[] = [];
    const posted = gate();

    const send = runAsEpochSend('g', async () => {
      trace.push('encrypt');
      await posted.promise;
      trace.push('post');
    });

    // Requested in the very window the defect used: the frame is encrypted, not yet posted.
    await Promise.resolve();
    expect(trace).toEqual(['encrypt']);
    const advance = runAsEpochAdvance('g', async () => {
      trace.push('advance');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(['encrypt']);

    posted.open();
    await Promise.all([send, advance]);

    // The post is BEFORE the advance: the recipients hold epoch N when the frame reaches them.
    expect(trace).toEqual(['encrypt', 'post', 'advance']);
  });

  it('registers the frame before any other task can raise a barrier', async () => {
    // The straddle was one await deep, so a registration that itself awaited would leave exactly
    // the window it was added to close. Raising a barrier in the same tick must find the frame.
    const trace: string[] = [];
    const posted = gate();

    const send = runAsEpochSend('g', async () => {
      trace.push('encrypt');
      await posted.promise;
      trace.push('post');
    });
    const advance = runAsEpochAdvance('g', async () => trace.push('advance'));

    posted.open();
    await Promise.all([send, advance]);

    expect(trace).toEqual(['encrypt', 'post', 'advance']);
  });

  it('releases the barrier when the advance FAILS, because a refused commit moves no epoch', async () => {
    const advance = runAsEpochAdvance('g', async () => {
      throw new Error('Staged commit rejected: epoch_mismatch');
    });

    await expect(advance).rejects.toThrow('epoch_mismatch');
    expect(isEpochAdvanceInFlight('g')).toBe(false);

    // And a send is not left waiting on a transaction that is over.
    await expect(runAsEpochSend('g', async () => 'sent')).resolves.toBe('sent');
  });

  it('propagates what the send itself threw, and stops holding the group', async () => {
    await expect(
      runAsEpochSend('g', async () => {
        throw new Error('POST failed');
      })
    ).rejects.toThrow('POST failed');

    const trace: string[] = [];
    await runAsEpochAdvance('g', async () => trace.push('advance'));
    expect(trace).toEqual(['advance']);
  });

  it('never makes one group wait on another', async () => {
    const trace: string[] = [];
    const merge = gate();

    const advance = runAsEpochAdvance('g1', async () => {
      await merge.promise;
      trace.push('g1:advance');
    });
    await runAsEpochSend('g2', async () => trace.push('g2:send'));

    // g2's frame went out while g1's commit was still open.
    expect(trace).toEqual(['g2:send']);

    merge.open();
    await advance;
    expect(trace).toEqual(['g2:send', 'g1:advance']);
  });

  it('waits out a SECOND advance rather than slipping between two commits', async () => {
    // A frame encrypted between two commits is exactly as stale as one encrypted before either, so
    // the wait is a loop and not a single await.
    const trace: string[] = [];
    const first = gate();
    const second = gate();

    const a1 = runAsEpochAdvance('g', async () => {
      await first.promise;
      trace.push('advance:1');
    });
    const send = runAsEpochSend('g', async () => trace.push('encrypt'));

    // The second commit is raised in the same tick the first releases, which is what a batched
    // add-then-remove does.
    first.open();
    await a1;
    const a2 = runAsEpochAdvance('g', async () => {
      await second.promise;
      trace.push('advance:2');
    });

    await Promise.resolve();
    await Promise.resolve();
    second.open();
    await Promise.all([a2, send]);

    expect(trace[trace.length - 1]).toBe('encrypt');
  });
});
