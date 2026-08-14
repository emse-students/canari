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

describe('waitForMessageQueueIdle', () => {
  let svc: BaseMlsService;
  let waitUntilIdle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    svc = makeService();
    waitUntilIdle = vi.fn().mockResolvedValue(undefined);
    poke(svc, { userId: 'user-a', messageScheduler: { waitUntilIdle } });
  });

  it('does not call the mailbox empty while pages are still being pulled', async () => {
    const pull = gate();
    poke(svc, {
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn().mockReturnValue(pull.promise),
      },
    });

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

  it('resolves on the scheduler alone when no pull is running', async () => {
    await svc.waitForMessageQueueIdle();

    expect(waitUntilIdle).toHaveBeenCalledTimes(1);
  });

  it('is not held open by a pull that failed - a transport error is not a full mailbox', async () => {
    poke(svc, {
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn().mockRejectedValue(new Error('offline')),
      },
    });

    // `fetchPendingMessages` swallows the failure (the backlog stays on the server for the next
    // reconnect), so the barrier must not inherit a rejection - nor stay pending for ever.
    await svc.fetchPendingMessages();
    await expect(svc.waitForMessageQueueIdle()).resolves.toBeUndefined();
  });
});
