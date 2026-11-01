// @vitest-environment happy-dom
/**
 * OUT OF FRONT ON AN iPHONE, THE PAGE CONSUMES NO QUEUED FRAME (`appActive.ts`).
 *
 * The notification extension decrypts read-only from `mls.bin`; a frame the page has already
 * consumed has spent its secret, so the server's push for it would be announced with no content.
 * So while the app is inactive every queued frame is left exactly as the server holds it - not
 * decrypted, not ACKed, re-admissible by the pull on return - and the server is asked to push it
 * now. Each case below fails without the gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isIosTauriRuntime: () => true,
}));

const { BaseMlsService } = await import('$lib/services/BaseMlsService');
const { setIosLiveCallGroup } = await import('$lib/utils/appActive');
type Service = InstanceType<typeof BaseMlsService>;
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

abstract class Harness extends BaseMlsService {}
const makeService = (): Service =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => Service)('tauri');

const inner = (svc: Service) =>
  svc as unknown as {
    messageScheduler: MlsPerGroupScheduler;
    enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void;
  };

const row = (queuedMessageId: string, groupId = 'group-a'): MlsQueuedMessage => ({
  senderId: 'alice',
  ciphertext: new Uint8Array([1]),
  groupId,
  isWelcome: false,
  isCommit: false,
  queuedMessageId,
});

/** What iOS tells the page (`CanariPushActiveToPage`). */
function active(value: boolean) {
  (window as unknown as Record<string, unknown>).__canariActive = value;
  window.dispatchEvent(new CustomEvent('canari:active', { detail: { active: value } }));
}

describe('a queued frame while the iPhone app is inactive', () => {
  let svc: Service;
  let applied: string[];
  let ack: ReturnType<typeof vi.fn>;
  let pushNow: ReturnType<typeof vi.fn>;
  let pull: ReturnType<typeof vi.fn>;

  const deliver = async (msg: MlsQueuedMessage, channel: DeliveryChannel = 'live') => {
    inner(svc).enqueueMessage(msg, channel);
    await inner(svc).messageScheduler.waitUntilIdle();
    // `onDrainEnd` fires the ack and the push-now without awaiting them.
    await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    active(true);
    svc = makeService();
    applied = [];
    ack = vi.fn().mockResolvedValue(undefined);
    pushNow = vi.fn().mockResolvedValue(undefined);
    pull = vi.fn().mockResolvedValue(undefined);
    Object.assign(svc, {
      userId: 'user-a',
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId: string }).queuedMessageId);
        return true;
      }),
      delivery: { ackMessages: ack, pushQueuedNow: pushNow, pullPendingMessagesJson: vi.fn() },
      fetchPendingMessages: pull,
    });
  });

  afterEach(() => {
    (svc as unknown as { offIosActive: (() => void) | null }).offIosActive?.();
    vi.restoreAllMocks();
    active(true);
  });

  it('ACTIVE: consumed and ACKed as before', async () => {
    await deliver(row('q-front'));
    expect(applied).toEqual(['q-front']);
    expect(ack).toHaveBeenCalledWith(['q-front']);
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('INACTIVE: not decrypted, not ACKed, and the server is asked to push it now', async () => {
    active(false);
    await deliver(row('q-back'));
    expect(applied).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
    expect(pushNow).toHaveBeenCalledWith(['q-back']);
  });

  it('a Welcome and a commit are left too - one rule, no frame-type split', async () => {
    active(false);
    await deliver({ ...row('q-welcome', 'group-w'), isWelcome: true });
    await deliver({ ...row('q-commit', 'group-c'), isCommit: true });
    expect(applied).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('nothing remembers it: the pull on return is admitted and consumes it', async () => {
    active(false);
    await deliver(row('q-1'), 'live');
    active(true);
    expect(pull).toHaveBeenCalledTimes(1);
    await deliver(row('q-1'), 'pull');
    expect(applied).toEqual(['q-1']);
    expect(ack).toHaveBeenCalledWith(['q-1']);
  });

  it('returning with nothing left queued pulls nothing', async () => {
    active(false);
    active(true);
    expect(pull).not.toHaveBeenCalled();
  });

  it('THE BOUNDARY: a frame that started while active completes, banner and ACK, even if the app resigns mid-decrypt', async () => {
    let release!: () => void;
    Object.assign(svc, {
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId: string }).queuedMessageId);
        await new Promise<void>((r) => (release = r));
        return true;
      }),
    });
    inner(svc).enqueueMessage(row('q-edge'), 'live');
    await vi.waitFor(() => expect(applied).toEqual(['q-edge']));
    active(false);
    release();
    await inner(svc).messageScheduler.waitUntilIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).toHaveBeenCalledWith(['q-edge']);
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('ACTIVE MID-DRAIN: both frames of the group come back in ONE pull after the drain, applied in order, none stranded', async () => {
    // One drain, round robin: group-a's first frame is left (inactive), a frame with no queued row
    // in group-b is consumed and the app becomes active during it, then group-a's second frame -
    // left too, because its group already has one queued. The release waits for the drain's end:
    // a pull started mid-drain had its copy of q-a2 refused while the drain still held the original.
    Object.assign(svc, {
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId?: string } | undefined)?.queuedMessageId ?? 'b');
        active(true);
        return true;
      }),
    });
    const pulledWhileDraining: boolean[] = [];
    Object.assign(svc, {
      fetchPendingMessages: vi.fn(async () => {
        pulledWhileDraining.push(inner(svc).messageScheduler.draining);
        inner(svc).enqueueMessage(row('q-a1'), 'pull');
        inner(svc).enqueueMessage(row('q-a2'), 'pull');
      }),
    });
    active(false);
    inner(svc).enqueueMessage(row('q-a1'), 'live');
    inner(svc).enqueueMessage({ ...row('', 'group-b'), queuedMessageId: undefined }, 'live');
    inner(svc).enqueueMessage(row('q-a2'), 'live');
    await vi.waitFor(() => expect(applied).toEqual(['b', 'q-a1', 'q-a2']));
    await inner(svc).messageScheduler.waitUntilIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(pulledWhileDraining).toEqual([false]);
    expect(ack).toHaveBeenCalledWith(['q-a1', 'q-a2']);
    // Released before the end of the drain, so nothing is asked to be pushed.
    expect(pushNow).not.toHaveBeenCalled();
  });

  describe('a released group holds its live frames behind the release pull', () => {
    /** The real pull, its server answered by `serve` - which may deliver live frames meanwhile. */
    const realPull = (serve: () => Promise<void>) => {
      Object.assign(svc, {
        fetchPendingMessages: BaseMlsService.prototype.fetchPendingMessages,
        delivery: {
          ackMessages: ack,
          pushQueuedNow: pushNow,
          pullPendingMessagesJson: vi.fn(serve),
        },
      });
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('a live frame arriving during the release pull is applied AFTER the pull brought the withheld one', async () => {
      active(false);
      await deliver(row('q-w1'));
      realPull(async () => {
        // The socket is still open: the next message lands live before the pull's page does.
        inner(svc).enqueueMessage(row('q-live'), 'live');
        await tick();
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
      });
      active(true);
      await vi.waitFor(() => expect(applied).toEqual(['q-w1', 'q-live']));
    });

    it('a withheld COMMIT, then a live next-epoch frame: read in epoch order, nothing refused, nothing to heal', async () => {
      let epoch = 1;
      const refused: string[] = [];
      Object.assign(svc, {
        messageCallback: vi.fn(async (...args: unknown[]) => {
          const id = (args[6] as { queuedMessageId: string }).queuedMessageId;
          if (id === 'q-commit') epoch = 2;
          if (id === 'q-epoch2' && epoch < 2) {
            refused.push(id);
            return false;
          }
          applied.push(id);
          return true;
        }),
      });
      active(false);
      await deliver({ ...row('q-commit'), isCommit: true });
      realPull(async () => {
        inner(svc).enqueueMessage(row('q-epoch2'), 'live');
        await tick();
        inner(svc).enqueueMessage({ ...row('q-commit'), isCommit: true }, 'pull');
      });
      active(true);
      await vi.waitFor(() => expect(applied).toEqual(['q-commit', 'q-epoch2']));
      expect(refused).toEqual([]);
    });

    it('a FAILED release pull keeps the group parked: a live frame waits, and starts ONE pull, which fails too', async () => {
      active(false);
      await deliver(row('q-w1'));
      const serve = vi.fn(async () => {
        throw new Error('server error');
      });
      realPull(serve);
      active(true);
      await vi.waitFor(() => expect(serve).toHaveBeenCalledTimes(1));
      await tick();
      await deliver(row('q-live'));
      await tick();
      expect(applied).toEqual([]);
      // The arriving frame started one pull; that pull's own failure starts none.
      await vi.waitFor(() => expect(serve).toHaveBeenCalledTimes(2));
      await tick();
      await tick();
      expect(serve).toHaveBeenCalledTimes(2);
    });

    it('TERMINATION: after a failed release pull, the next live frame pulls, and nothing is called by hand', async () => {
      active(false);
      await deliver(row('q-w1'));
      realPull(async () => {
        throw new Error('server error');
      });
      active(true);
      await tick();
      await tick();
      realPull(async () => {
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
        inner(svc).enqueueMessage(row('q-live'), 'pull');
      });
      await deliver(row('q-live'));
      await vi.waitFor(() => expect(applied).toEqual(['q-w1', 'q-live']));
    });

    it('a parked frame the pull brought is not handed back, even once the delivery memory forgot it', async () => {
      active(false);
      await deliver(row('q-w1'));
      realPull(async () => {
        inner(svc).enqueueMessage(row('q-live'), 'live');
        await tick();
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
        inner(svc).enqueueMessage(row('q-live'), 'pull');
        await inner(svc).messageScheduler.waitUntilIdle();
        // The bounded delivery memory evicted both (`DELIVERY_MEMORY`).
        (svc as unknown as { deliveries: Map<string, string> }).deliveries.clear();
      });
      active(true);
      await vi.waitFor(() => expect(applied).toEqual(['q-w1', 'q-live']));
      await inner(svc).messageScheduler.waitUntilIdle();
      await tick();
      expect(applied).toEqual(['q-w1', 'q-live']);
    });

    it('a group with frames still queued here is not released now: the drain that empties it decides', async () => {
      active(false);
      await deliver(row('q-w1'));
      const idle = vi
        .spyOn(inner(svc).messageScheduler, 'isGroupIdle')
        .mockImplementation(() => false);
      active(true);
      expect(pull).not.toHaveBeenCalled();
      idle.mockRestore();
      // The drain of any frame ends, and decides then.
      await deliver({ ...row('', 'group-z'), queuedMessageId: undefined });
      expect(pull).toHaveBeenCalledTimes(1);
    });
  });

  describe('"drained" counts the frames held back', () => {
    const drainedInner = () =>
      svc as unknown as {
        mailboxEmptiedByAPull: boolean;
        isWsOpen(): boolean;
      };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const releaseBy = (serve: () => Promise<void>) =>
      Object.assign(svc, {
        fetchPendingMessages: BaseMlsService.prototype.fetchPendingMessages,
        delivery: {
          ackMessages: ack,
          pushQueuedNow: pushNow,
          pullPendingMessagesJson: vi.fn(serve),
        },
      });

    beforeEach(() => {
      Object.assign(svc, { mailboxEmptiedByAPull: true, isWsOpen: () => true });
    });

    it('a withheld frame (a key-group commit) keeps its group NOT drained, though a pull emptied the mailbox', async () => {
      active(false);
      await deliver({ ...row('q-commit', 'key-group'), isCommit: true });
      expect(drainedInner().mailboxEmptiedByAPull).toBe(true);
      expect(svc.isGroupDrained('key-group')).toBe(false);
    });

    it('a drained waiter wakes only once the parked frames are applied - the release is listed before the wake', async () => {
      active(false);
      await deliver(row('q-w1'));
      releaseBy(async () => {
        inner(svc).enqueueMessage(row('q-live'), 'live');
        await tick();
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
      });
      let seenAtWake: string[] | null = null;
      void svc.whenGroupDrained('group-a').then(() => (seenAtWake = [...applied]));
      active(true);
      await vi.waitFor(() => expect(seenAtWake).toEqual(['q-w1', 'q-live']));
    });

    it('waitForGroupQueueIdle waits for the withheld frames to be back and applied', async () => {
      active(false);
      await deliver(row('q-w1'));
      let done = false;
      void svc.waitForGroupQueueIdle('test', 'group-a').then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      releaseBy(async () => {
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
      });
      active(true);
      await vi.waitFor(() => expect(done).toBe(true));
      expect(applied).toEqual(['q-w1']);
    });

    it('TERMINATION WITH NO FRAME: after a failed release pull, a drained waiter starts exactly one pull, which ends the release', async () => {
      active(false);
      await deliver(row('q-w1'));
      const failing = vi.fn(async () => {
        throw new Error('server error');
      });
      releaseBy(failing);
      active(true);
      await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
      await tick();
      await tick();
      // The socket delivers nothing more for the group: only the wait can start the pull.
      const serve = vi.fn(async () => {
        inner(svc).enqueueMessage(row('q-w1'), 'pull');
      });
      releaseBy(serve);
      let drained = false;
      void svc.whenGroupDrained('group-a').then(() => (drained = true));
      void svc.whenGroupDrained('group-a');
      await vi.waitFor(() => expect(drained).toBe(true));
      expect(serve).toHaveBeenCalledTimes(1);
      expect(applied).toEqual(['q-w1']);
    });
  });

  it('an ACTIVE app with a deferred group asks the server to push nothing', async () => {
    active(false);
    await deliver(row('q-w1'));
    pushNow.mockClear();
    // The group still has a frame queued here when the app becomes active: its release is deferred.
    const idle = vi
      .spyOn(inner(svc).messageScheduler, 'isGroupIdle')
      .mockImplementation(() => false);
    active(true);
    await deliver({ ...row('q-w2'), queuedMessageId: 'q-w2' });
    idle.mockRestore();
    expect(pushNow).not.toHaveBeenCalled();
  });

  describe('the group of a live call', () => {
    afterEach(() => setIosLiveCallGroup(null));

    it('is consumed out of front - its hangup and answer are frames of that group - while another group is still left', async () => {
      active(false);
      setIosLiveCallGroup('group-call');
      await deliver(row('q-hangup', 'group-call'));
      await deliver(row('q-other', 'group-x'));
      expect(applied).toEqual(['q-hangup']);
      expect(ack).toHaveBeenCalledWith(['q-hangup']);
      expect(pushNow).toHaveBeenCalledWith(['q-other']);
    });

    it('a frame of it left before the call went live is pulled back when it does', async () => {
      active(false);
      await deliver(row('q-before', 'group-call'));
      expect(applied).toEqual([]);
      setIosLiveCallGroup('group-call');
      expect(pull).toHaveBeenCalledTimes(1);
      await deliver(row('q-before', 'group-call'), 'pull');
      expect(applied).toEqual(['q-before']);
    });
  });
});
