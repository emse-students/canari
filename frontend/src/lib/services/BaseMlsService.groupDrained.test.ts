/**
 * `isGroupDrained` - "has this device merged everything the server holds for the group", read as a
 * fact and never waited for (the admission gate's first observation stands on it,
 * channel-encryption section 25). Each case removes ONE piece of the evidence and expects `false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import { GroupDrainAbandonedError } from '$lib/mls-client/IMlsService';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** A service whose last pull emptied the mailbox, with no pull running and its socket open. */
function drainedService(idle: (groupId: string) => boolean = () => true): BaseMlsService {
  const svc = makeService();
  Object.assign(svc, {
    mailboxEmptiedByAPull: true,
    pendingPullInFlight: null,
    isWsOpen: () => true,
    messageScheduler: { isGroupIdle: idle },
  });
  return svc;
}

describe('isGroupDrained', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  it('holds when the last pull emptied the mailbox, none runs, the socket is open and the group is idle', () => {
    expect(drainedService().isGroupDrained('g-1')).toBe(true);
  });

  it('does not hold before a pull has listed the whole mailbox', () => {
    const svc = drainedService();
    Object.assign(svc, { mailboxEmptiedByAPull: false });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold while a pull is running', () => {
    const svc = drainedService();
    Object.assign(svc, { pendingPullInFlight: new Promise<void>(() => undefined) });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold once the socket the pull was trusted with has dropped', () => {
    const svc = drainedService();
    Object.assign(svc, { isWsOpen: () => false });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold while the group has frames queued, parked or being applied', () => {
    const svc = drainedService((groupId) => groupId !== 'g-1');
    expect(svc.isGroupDrained('g-1')).toBe(false);
    expect(svc.isGroupDrained('g-2')).toBe(true);
  });
});

/**
 * `whenGroupDrained` - the same fact as an EVENT. It is woken where the evidence changes (a group's
 * frames done, a pull ended) and nowhere else, so these drive those two events and nothing else.
 */
describe('whenGroupDrained', () => {
  /** The service's own scheduler and pull, reached the way the class reaches them. */
  const inner = (svc: BaseMlsService) =>
    svc as unknown as {
      messageScheduler: MlsPerGroupScheduler;
      fetchPendingMessages(): Promise<void>;
    };

  /** A service with its real scheduler, its socket open, and a pull that lists an empty mailbox. */
  function liveService(): BaseMlsService {
    const svc = makeService();
    Object.assign(svc, {
      userId: 'user-a',
      isWsOpen: () => true,
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
      },
    });
    return svc;
  }

  const frameOf = (groupId: string): MlsQueuedMessage => ({
    senderId: 'bob',
    ciphertext: new Uint8Array(1),
    groupId,
    isWelcome: false,
    isCommit: false,
  });

  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('resolves at once on a drained group', async () => {
    const svc = liveService();
    Object.assign(svc, { mailboxEmptiedByAPull: true });
    await expect(svc.whenGroupDrained('g-1')).resolves.toBeUndefined();
  });

  it('waits for the first full pull at start-up, and resolves when that pull ends', async () => {
    const svc = liveService();
    let drained = false;
    void svc.whenGroupDrained('g-1').then(() => {
      drained = true;
    });
    // Idle, socket open - but nothing has listed the mailbox yet.
    await Promise.resolve();
    expect(drained).toBe(false);

    await inner(svc).fetchPendingMessages();
    await Promise.resolve();
    expect(drained).toBe(true);
  });

  it('asked from INSIDE one of the group frames, resolves only once that frame has returned', async () => {
    const svc = liveService();
    Object.assign(svc, { mailboxEmptiedByAPull: true });
    const scheduler = inner(svc).messageScheduler;
    const order: string[] = [];
    scheduler.enqueue(frameOf('g-1'));

    await scheduler.drain(async () => {
      order.push('frame');
      // The ask's own frame: chained on, never awaited - awaiting it here could never return.
      void svc.whenGroupDrained('g-1').then(() => order.push('drained'));
      await Promise.resolve();
      await Promise.resolve();
      order.push('frame returned');
    });
    await Promise.resolve();

    expect(order).toEqual(['frame', 'frame returned', 'drained']);
  });

  it('stays pending while the pull that would prove the mailbox empty fails', async () => {
    const svc = liveService();
    Object.assign(svc, {
      delivery: {
        ackMessages: vi.fn().mockResolvedValue(undefined),
        pullPendingMessagesJson: vi.fn().mockRejectedValue(new Error('500')),
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let drained = false;
    void svc.whenGroupDrained('g-1').then(() => {
      drained = true;
    });

    await inner(svc).fetchPendingMessages();
    await Promise.resolve();

    expect(drained).toBe(false);
    // The wait is visible: the failed pull says what it holds up.
    expect(info.mock.calls.flat().join(' ')).toContain(
      '1 drain waiter(s) (parked seed asks, admission observations) wait for a pull that completes'
    );
  });

  it('is rejected, typed, when the service is destroyed - no waiter outlives sign-out', async () => {
    const svc = liveService();
    Object.assign(svc, { destroyPlatformResources: () => undefined });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const waiting = svc.whenGroupDrained('g-1');

    svc.destroy();

    await expect(waiting).rejects.toBeInstanceOf(GroupDrainAbandonedError);
    expect(
      (svc as unknown as { pendingGroupDrainWaiters(): number }).pendingGroupDrainWaiters()
    ).toBe(0);
  });
});
