/**
 * A PULL MUST NOT OVERTAKE THIS DEVICE'S OWN ACKNOWLEDGEMENT - the ordering, asserted directly.
 *
 * Every ack site in `BaseMlsService` is fire-and-forget, and that is correct: a drain must not wait
 * on an HTTP round trip. What was missing is that nothing ANNOUNCED them, so the one path that must
 * not overtake an ack could not wait for it - and that path is not hypothetical, it is scheduled.
 * `onDrainEnd` acks the rows it just drained and, in the same tick, `refetchFramesLeftBehind` calls
 * `fetchPendingMessages`. The server has not recorded the ack yet, so it hands the same rows back
 * and the device meets its own frames again: `[QUEUE] delivery ... arrived twice - the pull listed a
 * row this device had already acknowledged - its own ack was still in flight when the pull was
 * answered`. Four campaign rows carried it as their only dirt.
 *
 * SO THE ASSERTIONS ARE ABOUT ORDER, NOT ABOUT COUNTS. A test that only counted duplicates would
 * pass on a sleep. These pin the happens-before: the ack request is issued and RESOLVES before the
 * pull is issued at all, and a second ack never overtakes a first.
 *
 * AND A FAILING ACK MUST NOT BECOME A STALLED PULL, which is the one way this fix could be worse
 * than the defect. When the ack cannot land, the server really does still hold those rows - a pull
 * that lists them again is telling the truth - so the pull must proceed, and one case asserts
 * exactly that.
 *
 * THE LAST CASE IS ABOUT WHAT THE LINE SAYS AFTERWARDS, and it is the half that keeps the fix
 * watched. `pull:done` was classified as routine on a measurement of the race this deletes (23 of
 * 25 forwards, FWD-2), so leaving it there would describe a state the code now prevents and hide a
 * regression behind a sentence nobody reads. It accuses instead - unless this device knows the ack
 * never got through, which is a fact it holds rather than one it has to infer from the repeat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

/** The class's own seams, reached the way the class reaches them. */
const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    announceAck(messageIds: string[]): Promise<void>;
    fetchPendingMessages(): Promise<void>;
  };

/** A promise this test resolves by hand, so ordering is decided here rather than by a clock. */
const deferred = (): { promise: Promise<void>; settle: () => void; fail: (e: Error) => void } => {
  let settle!: () => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });
  return { promise, settle, fail };
};

describe('the ack barrier in front of a pull', () => {
  let svc: BaseMlsService;
  /** Everything either side did, in the order it happened - the sequence IS the assertion. */
  let order: string[];

  beforeEach(() => {
    svc = makeService();
    order = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    poke(svc, { userId: 'user-a', messageCallback: vi.fn().mockResolvedValue(true) });
  });

  it('does not issue the pull until an ack still in flight has landed', async () => {
    const ackLanding = deferred();
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async (ids: string[]) => {
          order.push(`ack:${ids.join(',') || '(flush)'}`);
          await ackLanding.promise;
          order.push('ack:landed');
        }),
        pullPendingMessagesJson: vi.fn(async () => {
          order.push('pull');
        }),
      },
    });

    // The drain's ack: issued, never awaited, exactly as `onDrainEnd` issues it.
    void inner(svc).announceAck(['row-1']);
    // And the pull `refetchFramesLeftBehind` starts in the same tick.
    const pulling = inner(svc).fetchPendingMessages();

    // Nothing may have pulled yet: the ack has been sent and has not come back.
    await Promise.resolve();
    expect(order).toEqual(['ack:row-1']);

    ackLanding.settle();
    await pulling;

    // The flush chains behind the drain's ack, and the pull comes after both.
    expect(order).toEqual(['ack:row-1', 'ack:landed', 'ack:(flush)', 'ack:landed', 'pull']);
  });

  /**
   * THE PULL IS ANNOUNCED IN THE TICK IT IS ASKED FOR, even while it waits for an ack to land.
   *
   * The ack ordering used to be awaited BEFORE `pendingPullInFlight` was set, so for one ack round
   * trip a pull had been asked for and no barrier could see it: an archive replay reaching
   * `waitForGroupQueueIdle` then passed straight through, decrypted the frame, and the pull
   * delivered it again (`Duplicate delivery`). The boot restore now asks for that pull before its
   * replays start, so the window would be crossed on every cold start.
   */
  it('lets a barrier entered while the ack is in flight wait for the pull', async () => {
    const ackLanding = deferred();
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async () => {
          await ackLanding.promise;
        }),
        pullPendingMessagesJson: vi.fn(async () => {
          order.push('pull');
        }),
      },
    });

    void inner(svc).announceAck(['row-1']);
    const pulling = inner(svc).fetchPendingMessages();
    expect((svc as unknown as { pendingPullInFlight: unknown }).pendingPullInFlight).not.toBeNull();

    const barrier = svc.waitForGroupQueueIdle('test', 'g-1').then(() => order.push('barrier'));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    ackLanding.settle();
    await pulling;
    await barrier;
    expect(order).toEqual(['pull', 'barrier']);
  });

  /**
   * TWO OVERLAPPING PULLS, AND THE FIRST TO FINISH MUST NOT BLIND THE BARRIER.
   *
   * The slot used to be overwritten by the second pull and nulled by whichever finished first, so a
   * barrier entered after that saw no pull at all while the other was still fetching - and decrypted
   * a frame that pull then delivered a second time.
   */
  it('keeps the barrier up until every overlapping pull has landed', async () => {
    const firstPage = deferred();
    const secondPage = deferred();
    let pulls = 0;
    poke(svc, {
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn(async () => {
          const mine = ++pulls;
          await (mine === 1 ? firstPage.promise : secondPage.promise);
          order.push(`pull-${mine}`);
        }),
      },
    });

    const first = inner(svc).fetchPendingMessages();
    const second = inner(svc).fetchPendingMessages();
    // Both have reached the server before either answers.
    await vi.waitFor(() => expect(pulls).toBe(2));

    // The SECOND pull's answer is still out when the first one lands.
    firstPage.settle();
    await vi.waitFor(() => expect(order).toEqual(['pull-1']));
    const slot = (svc as unknown as { pendingPullInFlight: unknown }).pendingPullInFlight;
    expect(slot).not.toBeNull();

    const barrier = svc.waitForGroupQueueIdle('test', 'g-1').then(() => order.push('barrier'));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['pull-1']);

    secondPage.settle();
    await Promise.all([first, second, barrier]);
    expect(order).toEqual(['pull-1', 'pull-2', 'barrier']);
    // And the slot is released once nothing is behind it, so a later barrier does not wait forever.
    expect((svc as unknown as { pendingPullInFlight: unknown }).pendingPullInFlight).toBeNull();
  });

  it('serialises two acks so the second cannot overtake the first', async () => {
    const first = deferred();
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async (ids: string[]) => {
          order.push(`start:${ids.join(',')}`);
          if (ids[0] === 'row-1') await first.promise;
          order.push(`end:${ids.join(',')}`);
        }),
        pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
      },
    });

    void inner(svc).announceAck(['row-1']);
    const second = inner(svc).announceAck(['row-2']);

    await Promise.resolve();
    // The second has not even been SENT: chaining is what makes awaiting the barrier a statement
    // about every ack rather than about the latest one.
    expect(order).toEqual(['start:row-1']);

    first.settle();
    await second;
    expect(order).toEqual(['start:row-1', 'end:row-1', 'start:row-2', 'end:row-2']);
  });

  it('lets the pull through when the ack cannot land, because the rows really are still owed', async () => {
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async () => {
          order.push('ack:failed');
          throw new Error('offline');
        }),
        pullPendingMessagesJson: vi.fn(async () => {
          order.push('pull');
        }),
      },
    });

    void inner(svc).announceAck(['row-1']);
    await inner(svc).fetchPendingMessages();

    // A rejected ack is an ORDERING that completed, not a barrier that holds: the pull runs, and
    // the duplicate it may then list is an honest one.
    expect(order).toEqual(['ack:failed', 'ack:failed', 'pull']);
  });

  it('drops a chained ack whose account has changed under it, rather than acking it as somebody else', async () => {
    const first = deferred();
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async (ids: string[]) => {
          order.push(`ack:${ids.join(',')}`);
          if (ids[0] === 'row-1') await first.promise;
        }),
        pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
      },
    });

    void inner(svc).announceAck(['row-1']);
    // LET THE FIRST ONE REALLY LEAVE. `announceAck` suspends on its own first `await`, so a switch
    // in the same tick would find BOTH acks still unstarted and drop both - correct, but not the
    // scenario this case is about, which is a second ack chained behind one already on the wire.
    await Promise.resolve();
    expect(order).toEqual(['ack:row-1']);

    const behind = inner(svc).announceAck(['row-2']);

    // The account switches while the first ack is still in flight - the window chaining widened.
    poke(svc, { userId: 'user-b' });
    first.settle();
    await behind;

    // `row-2` is never sent: acknowledging it now would acknowledge user-a's row as user-b. Nothing
    // is lost - the server still holds it for user-a's next pull.
    expect(order).toEqual(['ack:row-1']);
  });

  it('accuses a repeat whose ack had landed, and explains one whose ack had not', async () => {
    let failing = true;
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async () => {
          if (failing) throw new Error('offline');
        }),
        pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
      },
    });
    const grumble = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const note = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const said = (spy: ReturnType<typeof vi.spyOn>) =>
      (spy.mock.calls as unknown[][]).map((c) => String(c[0])).join(' | ');

    // A row acknowledged by an ack that could NOT be delivered: the server really does still hold
    // it, so its repeat is the consequence of the `[ACK]` failure and must not be a second finding.
    await inner(svc)
      .announceAck(['row-1'])
      .catch(() => {});
    const svcInner = svc as unknown as {
      rememberDelivery(id: string, state: 'queued' | 'done'): void;
      admitDelivery(id: string | undefined, channel: 'pull' | 'live'): boolean;
    };
    svcInner.rememberDelivery('row-1', 'done');
    expect(svcInner.admitDelivery('row-1', 'pull')).toBe(false);
    expect(said(note)).toContain('really is still owed');
    expect(said(grumble)).not.toContain('row-1');

    // And one whose ack LANDED. Nothing routine explains that any more, so it accuses.
    failing = false;
    await inner(svc).announceAck(['row-2']);
    svcInner.rememberDelivery('row-2', 'done');
    expect(svcInner.admitDelivery('row-2', 'pull')).toBe(false);
    expect(said(grumble)).toContain('nothing routine explains this');
  });

  it('does not make a later pull wait on an ack that has already landed', async () => {
    poke(svc, {
      delivery: {
        ackMessages: vi.fn(async () => {
          order.push('ack');
        }),
        pullPendingMessagesJson: vi.fn(async () => {
          order.push('pull');
        }),
      },
    });

    await inner(svc).announceAck(['row-1']);
    await inner(svc).fetchPendingMessages();
    await inner(svc).fetchPendingMessages();

    // Three acks and two pulls: one issued here, then one flush per pull. The chain is cleared when
    // nothing is behind it, so it cannot grow across a long session.
    expect(order).toEqual(['ack', 'ack', 'pull', 'ack', 'pull']);
  });
});
