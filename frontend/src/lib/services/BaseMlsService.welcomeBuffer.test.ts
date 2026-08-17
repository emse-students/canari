/**
 * THE WELCOME BUFFERING WINDOW, FROM THE DRAIN THAT OPENS IT TO THE HANDLER THAT EMPTIES IT.
 *
 * `mlsPerGroupScheduler.test.ts` proves the scheduler's half in isolation: the window is opened by a
 * Welcome, survives a second one, and is released rather than emptied into nothing. What it cannot
 * prove is the half that matters to a user - that a frame parked behind a Welcome REACHES
 * `messageCallback`. The two outcomes of a Welcome are decided in `processQueue`, and a frame that
 * is re-queued into a bucket nobody drains again is dropped just as thoroughly as one deleted.
 *
 * Every frame here carries NO `queuedMessageId`, which is the whole reason the window's contents
 * cannot simply be discarded: that is a live WebSocket frame, the server holds no row naming it, and
 * a re-fetch cannot bring it back. A dropped one and one that never arrived look identical on
 * screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** Installs test doubles over protected collaborators, which no widened interface can describe. */
const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

/** The class's own seams, reached the way the class reaches them. */
const inner = (svc: BaseMlsService) =>
  svc as unknown as { messageScheduler: MlsPerGroupScheduler; processQueue(): Promise<void> };

/** A promise the test opens by hand, so every assertion is an ordering rather than a duration. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * A live WebSocket frame: no `queuedMessageId`, because that is the case the window may not drop.
 */
const frame = (
  groupId: string,
  senderId: string,
  overrides: Partial<MlsQueuedMessage> = {}
): MlsQueuedMessage => ({
  senderId,
  ciphertext: new Uint8Array([1]),
  groupId,
  isWelcome: false,
  isCommit: false,
  ...overrides,
});

describe('a frame parked behind a Welcome', () => {
  let svc: BaseMlsService;
  let scheduler: MlsPerGroupScheduler;
  /** `kind:group:sender`, in the order the pipeline actually applied them. */
  let applied: string[];
  let complaint: ReturnType<typeof vi.spyOn>;
  let note: ReturnType<typeof vi.spyOn>;

  /**
   * A handler that suspends on a gate, so the test controls where the drain is standing when the
   * next frame arrives. `hold` names the frames that wait; `fail` names the ones that then throw.
   */
  const handlerThat = (script: {
    hold?: Record<string, { started: () => void; release: Promise<void> }>;
    fail?: string[];
  }) =>
    vi.fn(
      async (
        senderId: string,
        _content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean
      ): Promise<boolean> => {
        applied.push(`${isWelcome ? 'welcome' : 'message'}:${groupId ?? 'unknown'}:${senderId}`);
        const held = script.hold?.[senderId];
        if (held) {
          held.started();
          await held.release;
        }
        if (script.fail?.includes(senderId)) throw new Error(`${senderId} could not be applied`);
        return true;
      }
    );

  beforeEach(() => {
    svc = makeService();
    scheduler = inner(svc).messageScheduler;
    applied = [];
    complaint = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    note = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    poke(svc, {
      userId: 'user-a',
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    complaint.mockRestore();
    note.mockRestore();
  });

  /** Every `console.log` line the drain emitted, joined - the re-queue is reported on this channel. */
  const logged = (): string => (note.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  it('is applied after the Welcome that makes it readable, not before', async () => {
    const started = gate();
    const release = gate();
    poke(svc, {
      messageCallback: handlerThat({
        hold: { alice: { started: started.open, release: release.promise } },
      }),
    });

    scheduler.enqueue(frame('group-a', 'alice', { isWelcome: true }));
    const draining = inner(svc).processQueue();
    await started.promise;

    // Arrives with the Welcome still in flight: the group is not readable yet, so applying it now
    // would fail to decrypt and the failure would be permanent.
    scheduler.enqueue(frame('group-a', 'bob'));
    expect(scheduler.getHeldCount()).toBe(1);
    // AND THE SCHEDULER SAYS SO. `isIdle` claims "nothing left to apply" to every mailbox barrier;
    // a held frame is something left to apply, whatever bucket it is not in.
    expect(scheduler.isIdle()).toBe(false);

    release.open();
    await draining;

    expect(applied).toEqual(['welcome:group-a:alice', 'message:group-a:bob']);
    expect(scheduler.getHeldCount()).toBe(0);
    expect(scheduler.isIdle()).toBe(true);
  });

  /**
   * THE DROP THIS ITEM IS ABOUT.
   *
   * A failed Welcome used to delete the window and everything in it, on the assumption that the
   * server would hand the frames over again. That is true only of a frame carrying a
   * `queuedMessageId`. For the one below there is nothing to re-fetch it by, and nothing was
   * logged either - so the loss left no trace at all.
   */
  it('survives a Welcome that FAILS, instead of being dropped with it', async () => {
    const started = gate();
    const release = gate();
    poke(svc, {
      messageCallback: handlerThat({
        hold: { alice: { started: started.open, release: release.promise } },
        fail: ['alice'],
      }),
    });

    scheduler.enqueue(frame('group-a', 'alice', { isWelcome: true }));
    const draining = inner(svc).processQueue();
    await started.promise;
    scheduler.enqueue(frame('group-a', 'bob'));

    release.open();
    await draining;

    // Re-queued, so the handler sees it. Its group is still unknown - the Welcome did not land - so
    // the handler records it against that group and the Welcome that eventually succeeds re-fetches
    // it, which is the seam `refetchFramesLeftBehind('unknown-group', ...)` exists for.
    expect(applied).toEqual(['welcome:group-a:alice', 'message:group-a:bob']);
    expect(scheduler.getHeldCount()).toBe(0);
    // The Welcome is still a failure and still says so: re-queuing what it held is not a recovery.
    expect((complaint.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n')).toContain(
      'Welcome failed for group=group-a'
    );
    // And the release is NAMED, because a silent one is what made the old drop survivable.
    expect(logged()).toContain('Welcome failed: re-queued 1 buffered message(s) for group-a');
  });

  /**
   * THE BRANCH THAT WAS DELETED, kept as a regression because its absence is invisible otherwise.
   *
   * A throwing NON-Welcome used to close its group's Welcome window. It was the one path able to
   * close a window it had not opened: a frame already in flight throws while a LATER Welcome, queued
   * behind it, has just opened one. It released what that Welcome was holding - so the frames were
   * not lost, they were applied AHEAD of the Welcome, against an epoch this client does not have
   * yet. Which for a frame carrying no `queuedMessageId` amounts to the same thing, one step later:
   * it fails to decrypt and there is nothing to hand it over again.
   *
   * The interleaving below is the reachable one - on web a Welcome is unshifted to the front of its
   * group, so it can only be overtaken by a frame that was already picked.
   */
  it('is not swept away by an unrelated frame of the same group failing', async () => {
    const started = gate();
    const release = gate();
    poke(svc, {
      messageCallback: handlerThat({
        hold: { alice: { started: started.open, release: release.promise } },
        fail: ['alice'],
      }),
    });

    scheduler.enqueue(frame('group-a', 'alice'));
    const draining = inner(svc).processQueue();
    await started.promise;

    // A re-add, or a server re-delivery: an ordinary event, and it opens a window.
    scheduler.enqueue(frame('group-a', 'carol', { isWelcome: true }));
    scheduler.enqueue(frame('group-a', 'bob'));
    expect(scheduler.getHeldCount()).toBe(1);

    release.open();
    await draining;

    expect(applied).toEqual([
      'message:group-a:alice',
      'welcome:group-a:carol',
      'message:group-a:bob',
    ]);
    expect(scheduler.getHeldCount()).toBe(0);
    expect(scheduler.isIdle()).toBe(true);
  });

  /**
   * THE NEGATIVE CONTROL for the drain's closing invariant.
   *
   * `releaseStrandedWelcomeBuffers` is an error-level accusation, so it has to be silent on every
   * healthy drain. It cannot be ARMED from here, which is the point: at this level the window is
   * opened by a Welcome and closed by that same Welcome finishing, either way, so no sequence of
   * public calls can strand one. The scheduler's own suite arms it directly - here the claim is
   * only that a normal Welcome never trips it.
   */
  it('does not accuse the drain of stranding a window it closed itself', async () => {
    poke(svc, { messageCallback: handlerThat({}) });

    scheduler.enqueue(frame('group-a', 'alice', { isWelcome: true }));
    scheduler.enqueue(frame('group-b', 'bob'));
    await inner(svc).processQueue();

    expect(applied).toEqual(['welcome:group-a:alice', 'message:group-b:bob']);
    expect(complaint).not.toHaveBeenCalled();
  });
});
