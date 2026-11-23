/**
 * A PULL STOPPED BY A REFUSED PAGE IS INCOMPLETE, AND THE NEXT NAMED EVENT PULLS AGAIN.
 *
 * `pullPendingMessagesJson` throws `PendingPullIncompleteError` on a non-2xx page. The mailbox is then
 * NOT known empty: the flag and the initial drain stay unset, and the drain waiters stay pending - which
 * is true. What must not happen is that they stay pending until some unrelated event: the next live
 * frame (the gateway link is up) pulls again, and when that pull completes whole they are released.
 * No clock anywhere: the sequence is decided by the test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import { PendingPullIncompleteError } from '$lib/mls-client/mlsDeliveryApi';
import type { MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    fetchPendingMessages(): Promise<void>;
    enqueueMessage(msg: MlsQueuedMessage, channel: 'live'): void;
    mailboxEmptiedByAPull: boolean;
    pullIncompleteOwed: boolean;
  };

const liveFrame = (): MlsQueuedMessage => ({
  senderId: 'bob',
  ciphertext: new Uint8Array([1]),
  groupId: 'g-1',
  isWelcome: false,
  isCommit: false,
  queuedMessageId: 'q-1',
});

describe('a pull stopped by a refused page', () => {
  let svc: BaseMlsService;
  let pull: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    svc = makeService();
    pull = vi
      .fn()
      .mockRejectedValueOnce(new PendingPullIncompleteError(503, 'gateway'))
      .mockResolvedValue([]);
    Object.assign(svc, {
      userId: 'user-a',
      deviceId: 'dev-a',
      isWsOpen: () => true,
      processQueue: vi.fn(),
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: pull,
      },
      messageScheduler: {
        enqueue: vi.fn(),
        draining: false,
        hasQueuedFrom: () => false,
        isGroupIdle: () => true,
        waitUntilIdle: async () => undefined,
      },
    });
  });

  it('leaves the mailbox unknown, then pulls again on the next live frame and releases the waiters', async () => {
    let initialDrainSettled = false;
    void svc.whenInitialDrainSettled().then(() => (initialDrainSettled = true));
    let groupDrained = false;
    void svc.whenGroupDrained('g-1').then(() => (groupDrained = true));

    await inner(svc).fetchPendingMessages();
    await Promise.resolve();

    expect(pull).toHaveBeenCalledTimes(1);
    expect(inner(svc).mailboxEmptiedByAPull).toBe(false);
    expect(initialDrainSettled).toBe(false);
    expect(groupDrained).toBe(false);
    expect(inner(svc).pullIncompleteOwed).toBe(true);

    // The named event: a live frame on the open link.
    inner(svc).enqueueMessage(liveFrame(), 'live');
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(initialDrainSettled).toBe(true));
    await vi.waitFor(() => expect(groupDrained).toBe(true));

    expect(inner(svc).mailboxEmptiedByAPull).toBe(true);
    expect(inner(svc).pullIncompleteOwed).toBe(false);
  });

  it('asks for the retry once, not once per live frame', async () => {
    await inner(svc).fetchPendingMessages();
    inner(svc).enqueueMessage(liveFrame(), 'live');
    inner(svc).enqueueMessage({ ...liveFrame(), queuedMessageId: 'q-2' }, 'live');
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    expect(pull).toHaveBeenCalledTimes(2);
  });
});
