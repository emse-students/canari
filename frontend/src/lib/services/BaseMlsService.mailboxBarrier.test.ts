/**
 * THE MAILBOX BARRIER COVERS THE FETCH AS WELL AS THE DRAIN.
 *
 * `waitForMessageQueueIdle` used to be `messageScheduler.waitUntilIdle()` alone, which answers "have
 * I applied everything I received" - not "have I received everything". The offline backlog is pulled
 * ONE PAGE AT A TIME, so between a drained page and the next one landing the scheduler is genuinely
 * idle while the mailbox is genuinely full. Measured on A1 at 976 rows / 36 MB: many pages, with
 * real network gaps between them.
 *
 * Everything that consults this barrier - the reconciliation ask, every responder leg, the archive
 * replay, the outbox flusher - is asking whether this device is a reliable source about its own
 * history. Mid-pull it is not, and the two cases below are the two halves of saying so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/**
 * A concrete instance of the abstract base.
 *
 * Nothing here calls a platform primitive, so none has to be implemented: the cast is what lets the
 * queue plumbing - which is entirely in the base class - be exercised without a WASM or Tauri
 * client behind it.
 */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/**
 * Installs test doubles over the base class's protected collaborators.
 *
 * Through `Object.assign` rather than a widened type: the members are protected, and an interface
 * that redeclares them as public does not describe the class - it just fails to compile.
 */
const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

/** A promise the test opens by hand, so the assertion is an ordering rather than a duration. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * THE SEND GATE - the third actor.
 *
 * Sequencing "drain, then history exchange" orders the two paths that READ this device's store and
 * leaves the one that WRITES to it free to land anywhere. On web a send during a catch-up is then
 * undone by the swap, and the NEXT frame re-uses a spent generation: measured 2026-08-14 across
 * three MSG-1b runs, `sendsDuringWindow=1` produced a `LOST frame` twice, `0` produced none, and the
 * frame named on the LOST line was byte for byte the send that followed the rewind.
 */
describe('waitForCatchUpIdle', () => {
  /** `beginCatchUp`/`endCatchUp` are protected: they are the class's own seam, not a public API. */
  const sessions = (svc: BaseMlsService) =>
    svc as unknown as { beginCatchUp(): void; endCatchUp(): void };

  it('lets a send through when no catch-up is open', async () => {
    await expect(makeService().waitForCatchUpIdle()).resolves.toBeUndefined();
  });

  it('holds a send for as long as a catch-up is open', async () => {
    const svc = makeService();
    sessions(svc).beginCatchUp();

    let through = false;
    const send = svc.waitForCatchUpIdle().then(() => {
      through = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(through).toBe(false);

    sessions(svc).endCatchUp();
    await send;
    expect(through).toBe(true);
  });

  it('needs EVERY open catch-up to close - a depth, not a flag', async () => {
    const svc = makeService();
    sessions(svc).beginCatchUp();
    sessions(svc).beginCatchUp();

    let through = false;
    const send = svc.waitForCatchUpIdle().then(() => {
      through = true;
    });

    // Nothing guarantees a single session at a time, and a flag would open the gate here - with a
    // second catch-up still running and its swap still to come.
    sessions(svc).endCatchUp();
    await Promise.resolve();
    await Promise.resolve();
    expect(through).toBe(false);

    sessions(svc).endCatchUp();
    await send;
    expect(through).toBe(true);
  });
});

describe('waitForMessageQueueIdle', () => {
  let svc: BaseMlsService;
  let waitUntilIdle: ReturnType<typeof vi.fn>;
  let pullPendingMessagesJson: ReturnType<typeof vi.fn>;

  /** A socket that is up, unless a case says otherwise. */
  const withSocket = (open: boolean) => poke(svc, { isWsOpen: () => open });

  beforeEach(() => {
    svc = makeService();
    waitUntilIdle = vi.fn().mockResolvedValue(undefined);
    pullPendingMessagesJson = vi.fn().mockResolvedValue(undefined);
    poke(svc, {
      userId: 'user-a',
      // The inbound consumer. Present in every case but the one that removes it on purpose: the
      // barrier refuses to pull without one, because nothing would drain what the pull enqueues.
      messageCallback: vi.fn().mockResolvedValue(true),
      messageScheduler: { waitUntilIdle },
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson,
      },
    });
    withSocket(true);
  });

  it('does not call the mailbox empty while pages are still being pulled', async () => {
    const pull = gate();
    pullPendingMessagesJson.mockReturnValue(pull.promise);

    const fetching = svc.fetchPendingMessages();
    await Promise.resolve();

    let idle = false;
    const barrier = svc.waitForMessageQueueIdle().then(() => {
      idle = true;
    });
    // Several turns: the scheduler resolves immediately, so a barrier that only consulted it would
    // already have reported an empty mailbox by now.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toBe(false);

    pull.open();
    await fetching;
    await barrier;
    expect(idle).toBe(true);
  });

  /**
   * WP-DUPDELIVERY-1. With no pull running, both halves used to resolve at once and the caller went
   * on to read the archive with its own frames still sitting on the server - which the next pull
   * then handed over as a `Duplicate delivery ... already read by the archive replay`. Waiting on
   * the pull that is RUNNING is not the same question as whether the mailbox is empty.
   */
  it('pulls when nothing else has, rather than calling an un-pulled mailbox empty', async () => {
    await svc.waitForMessageQueueIdle();

    expect(pullPendingMessagesJson).toHaveBeenCalledTimes(1);
    expect(waitUntilIdle).toHaveBeenCalled();
  });

  it('does not pull twice when a completed pull already emptied it', async () => {
    await svc.waitForMessageQueueIdle();
    await svc.waitForMessageQueueIdle();

    // Otherwise the bootstrap restore, which replays every conversation, spends one request per
    // conversation to be told the same nothing.
    expect(pullPendingMessagesJson).toHaveBeenCalledTimes(1);
  });

  it('pulls again once the socket has dropped, because frames queue while a device is unreachable', async () => {
    await svc.waitForMessageQueueIdle();
    withSocket(false);

    await svc.waitForMessageQueueIdle();

    expect(pullPendingMessagesJson).toHaveBeenCalledTimes(2);
  });

  it('is not held open by a pull that failed - a transport error is not a full mailbox', async () => {
    pullPendingMessagesJson.mockRejectedValue(new Error('offline'));

    // `fetchPendingMessages` swallows the failure (the backlog stays on the server for the next
    // reconnect), so the barrier must not inherit a rejection - nor stay pending for ever.
    await svc.fetchPendingMessages();
    await expect(svc.waitForMessageQueueIdle()).resolves.toBeUndefined();
  });

  /**
   * THE ONE CALLER THAT CANNOT BE SERVED, AND IS TOLD SO.
   *
   * A catch-up holds the MLS mutex for its whole life and the drain needs it for every message, so
   * awaiting the mailbox from inside a session waits for a drain that can never start - the client
   * stops for good. Shipped once, on 2026-08-15, and it wedged a browser mid-check. The barrier is
   * the only place that can see the state at the moment of the call, so it is where the fact is
   * stated rather than discovered.
   */
  it('refuses, loudly, to be awaited from inside a catch-up instead of never resolving', async () => {
    const catchUp = svc as unknown as { beginCatchUp(): void; endCatchUp(): void };
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    catchUp.beginCatchUp();

    // Resolving is the point: a promise that never settles here is exactly the defect.
    await expect(svc.waitForMessageQueueIdle()).resolves.toBeUndefined();
    expect(pullPendingMessagesJson).not.toHaveBeenCalled();
    expect(waitUntilIdle).not.toHaveBeenCalled();
    expect(complaint).toHaveBeenCalledOnce();

    // And it is the SESSION that is refused, not the device: once closed, the barrier works again.
    catchUp.endCatchUp();
    await svc.waitForMessageQueueIdle();
    expect(pullPendingMessagesJson).toHaveBeenCalledTimes(1);
    complaint.mockRestore();
  });

  /**
   * THE OTHER CALLER THAT CANNOT BE SERVED - the one that arrives too EARLY.
   *
   * `processQueue` returns at once while no message callback is set, so nothing empties the buckets
   * and `waitUntilIdle` has nothing to fire on. Since this barrier PULLS, awaiting it without a
   * consumer is what fills the queue it then waits on for ever.
   *
   * Measured on prod 2026-08-15: W2 held 2 frames queued since that morning's deadlock, and every
   * boot afterwards pulled them from inside the startup archive replay - which ran BEFORE
   * `setupMessageHandler` - and stopped there. No tab leadership, no socket, no error, on every
   * reload. W1 differed in nothing but an empty server-side mailbox and booted normally.
   */
  it('refuses, loudly, to be awaited before there is anything to drain the queue it pulls', async () => {
    poke(svc, { messageCallback: undefined });
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(svc.waitForMessageQueueIdle()).resolves.toBeUndefined();

    // Pulling is the harm here, not just the waiting: it is the pull that fills a queue nothing can
    // empty, so the refusal has to come BEFORE it.
    expect(pullPendingMessagesJson).not.toHaveBeenCalled();
    expect(waitUntilIdle).not.toHaveBeenCalled();
    expect(complaint).toHaveBeenCalledOnce();
    complaint.mockRestore();
  });

  it('pulls again after a failure, because a pull that died half-way proves nothing', async () => {
    pullPendingMessagesJson.mockRejectedValueOnce(new Error('offline'));

    await svc.fetchPendingMessages();
    await svc.waitForMessageQueueIdle();

    expect(pullPendingMessagesJson).toHaveBeenCalledTimes(2);
  });
});
