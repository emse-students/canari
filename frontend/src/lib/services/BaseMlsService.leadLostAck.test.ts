/**
 * AN ACK NEVER RUNS AHEAD OF THE DISK WHERE THE DISK IS THE ONLY COPY (review of #3321, 2026-11-14).
 *
 * An ack deletes the row from the server. A drain used to acknowledge a COMMIT or a WELCOME at its
 * end, while the checkpoint holding it was still sealing; a kill there - and, since #3321, a routine
 * hand-over or freeze, whose old leader's checkpoint is refused (#3371) - reloaded a state behind a
 * commit the server no longer had. Now:
 * - a commit or Welcome is acknowledged only once a LANDED checkpoint holds it;
 * - an application frame is acknowledged at once by the document that owns the state (the history
 *   archive is its second copy), and held like a commit by one that no longer does;
 * - an id a landed checkpoint already holds is acknowledged whatever the lead, so the new leader
 *   never meets a frame its disk has already spent (`SecretReuseError`, a false loss).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const role = vi.hoisted(() => ({ now: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({
  getTabLeadership: () => role.now,
  leaderLockReleasedForUnload: () => false,
}));

import { BaseMlsService } from '$lib/services/BaseMlsService';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import type { MlsStatePersister } from '$lib/mls-client/mlsStatePersister';
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

interface Hold {
  applied: Map<string, number>;
  structural: Set<string>;
  covered: () => Promise<void>;
}

const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    announceAck(messageIds: string[], hold?: Hold): Promise<void>;
    unacknowledged: Set<string>;
    inboundApplied: number;
    durableApplied: number;
    writeCheckpoint: (key: string, latch: unknown) => Promise<void>;
    persistCheckpoint(): Promise<void>;
  };

/** A checkpoint this test lands or refuses by hand, so the order is decided here, never by a clock. */
function checkpointByHand(svc: BaseMlsService) {
  let land!: () => void;
  let refuse!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    land = () => {
      // What a landed `persistCheckpoint` does: the applied count read at its export is durable.
      inner(svc).durableApplied = inner(svc).inboundApplied;
      resolve();
    };
    refuse = reject;
  });
  const covered = vi.fn(() => done);
  return { covered, land: () => land(), refuse: (e: Error) => refuse(e) };
}

describe('a drain ack and the checkpoint that covers it', () => {
  let svc: BaseMlsService;
  let order: string[];
  let ackMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    role.now = 'leader';
    resetStateAuthorityForTests();
    noteMlsStateLoaded(true);
    svc = makeService();
    order = [];
    ackMessages = vi.fn(async (ids: string[]) => {
      order.push(`ack:${ids.join(',')}`);
    });
    Object.assign(svc, { userId: 'user-a', delivery: { ackMessages } });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a commit is acknowledged only after the checkpoint holding it lands; the application frame beside it does not wait', async () => {
    inner(svc).inboundApplied = 2;
    const cp = checkpointByHand(svc);
    const hold: Hold = {
      applied: new Map([
        ['msg', 1],
        ['commit', 2],
      ]),
      structural: new Set(['commit']),
      covered: cp.covered,
    };
    const acking = inner(svc).announceAck(['msg', 'commit'], hold);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // THE DEFECT: the commit's row left the server while its state was only in memory.
    expect(ackMessages).not.toHaveBeenCalled();

    cp.land();
    order.push('checkpoint:landed');
    await acking;
    expect(order).toEqual(['checkpoint:landed', 'ack:msg,commit']);
  });

  it('a commit whose checkpoint is refused - the lead left while it sealed - stays on the server; the leader-owned message is acknowledged', async () => {
    inner(svc).inboundApplied = 2;
    const cp = checkpointByHand(svc);
    const acking = inner(svc).announceAck(['msg', 'commit'], {
      applied: new Map([
        ['msg', 1],
        ['commit', 2],
      ]),
      structural: new Set(['commit']),
      covered: cp.covered,
    });
    cp.refuse(new Error('follower-tab'));
    await acking;
    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['msg']);
    expect([...inner(svc).unacknowledged]).toEqual(['commit']);
  });

  it('once the lead left, an application frame no landed checkpoint holds is withheld - and one a landed checkpoint holds is acknowledged, so the new leader never meets it spent', async () => {
    // 'old' was applied and a checkpoint landed with it; 'late' was applied after.
    inner(svc).inboundApplied = 1;
    inner(svc).durableApplied = 1;
    inner(svc).inboundApplied = 2;
    const cp = checkpointByHand(svc);
    role.now = 'follower';
    const acking = inner(svc).announceAck(['old', 'late'], {
      applied: new Map([
        ['old', 1],
        ['late', 2],
      ]),
      structural: new Set(),
      covered: cp.covered,
    });
    // The checkpoint of a document that no longer owns the state is refused (#3371).
    cp.refuse(new Error('follower-tab'));
    await acking;
    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['old']);
    expect([...inner(svc).unacknowledged]).toEqual(['late']);
  });

  it('an owner acknowledges application frames without asking for a checkpoint at all', async () => {
    inner(svc).inboundApplied = 1;
    const cp = checkpointByHand(svc);
    await inner(svc).announceAck(['msg'], {
      applied: new Map([['msg', 1]]),
      structural: new Set(),
      covered: cp.covered,
    });
    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['msg']);
    expect(cp.covered).not.toHaveBeenCalled();
  });

  it('a checkpoint claims what was applied when it EXPORTED, not when it landed', async () => {
    inner(svc).inboundApplied = 3;
    inner(svc).writeCheckpoint = async () => {
      // A frame applied while the checkpoint seals is not in the blob being written.
      inner(svc).inboundApplied = 4;
    };
    await inner(svc).persistCheckpoint();
    expect(inner(svc).durableApplied).toBe(3);
  });
});

describe('a withheld commit listed again by a pull (second review of #3321)', () => {
  afterEach(() => {
    unregisterMlsStatePersister();
    vi.restoreAllMocks();
  });

  it('its re-ack waits for a checkpoint covering it, rather than deleting the row the hold kept', async () => {
    role.now = 'leader';
    resetStateAuthorityForTests();
    noteMlsStateLoaded(true);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const svc = makeService();
    const ackMessages = vi.fn(async (_ids: string[]) => undefined);
    Object.assign(svc, { userId: 'user-a', delivery: { ackMessages } });
    const internals = svc as unknown as {
      rememberDelivery(
        id: string,
        record: { state: 'queued' | 'done'; via: DeliveryChannel }
      ): void;
      admitDelivery(id: string, arrival: { channel: 'pull'; listedAfterAck: number }): boolean;
      ackSerial: number;
      ackInFlight: Promise<void> | null;
    };
    // The drain applied the commit and settled it `done`; its checkpoint was then refused.
    internals.rememberDelivery('commit', { state: 'done', via: 'live' });
    inner(svc).inboundApplied = 1;
    const refused = checkpointByHand(svc);
    const drainAck = inner(svc).announceAck(['commit'], {
      applied: new Map([['commit', 1]]),
      structural: new Set(['commit']),
      covered: refused.covered,
    });
    refused.refuse(new Error('stale'));
    await drainAck;
    expect(ackMessages).not.toHaveBeenCalled();

    // The next pull lists the row again: dropped as a repeat, and acknowledged once more - but only
    // behind a checkpoint that holds it, asked of the persister now.
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const flushEncrypted = vi.fn(async () => {
      await landed;
      inner(svc).durableApplied = inner(svc).inboundApplied;
    });
    registerMlsStatePersister({ flushEncrypted } as unknown as MlsStatePersister);
    expect(
      internals.admitDelivery('commit', { channel: 'pull', listedAfterAck: internals.ackSerial })
    ).toBe(false);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(flushEncrypted).toHaveBeenCalled();
    // THE DEFECT: the repeat's re-ack deleted the row while no landed checkpoint held the commit.
    expect(ackMessages).not.toHaveBeenCalled();

    land();
    await internals.ackInFlight;
    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['commit']);
  });
});

describe('a document leaving the lead reloads only once its ingest windows have closed (second review of #3321)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('settles at once with no window, and otherwise only once the last observer close has returned', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const svc = makeService();
    let settledEarly = false;
    await svc.whenBulkIngestsClosed().then(() => (settledEarly = true));
    expect(settledEarly).toBe(true);

    // The UI observer stores the drain's buffered rows in its close: the wait covers that close.
    let rowsStored!: () => void;
    const storing = new Promise<void>((r) => (rowsStored = r));
    svc.addBulkIngestObserver({
      onBulkIngestStart: () => undefined,
      onBulkIngestEnd: () => storing,
    });
    const drain = svc.beginBulkIngest({ bufferUi: true, showOverlay: false });
    const replay = svc.beginBulkIngest();
    let settled = false;
    void svc.whenBulkIngestsClosed().then(() => (settled = true));
    const closingDrain = svc.endBulkIngest(drain);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    rowsStored();
    await closingDrain;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Another window is still open.
    expect(settled).toBe(false);
    await svc.endBulkIngest(replay);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('is not held by a window opened after it asked (third review of #3321)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const svc = makeService();
    const drain = svc.beginBulkIngest({ bufferUi: true, showOverlay: false });
    let settled = false;
    void svc.whenBulkIngestsClosed().then(() => (settled = true));
    // The next drain opens before the first closes - a restart behind each close would otherwise
    // keep the count above zero for as long as frames keep coming.
    const next = svc.beginBulkIngest({ bufferUi: true, showOverlay: false });
    await svc.endBulkIngest(drain);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(true);
    await svc.endBulkIngest(next);
  });
});

describe('the drain wires it: a commit it applied waits for the persister checkpoint the drain started', () => {
  afterEach(() => {
    unregisterMlsStatePersister();
    vi.restoreAllMocks();
  });

  it('acknowledges the message at its end, and the commit only once that checkpoint has landed', async () => {
    role.now = 'leader';
    resetStateAuthorityForTests();
    noteMlsStateLoaded(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const svc = makeService();
    const acked: string[][] = [];
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const flushEncrypted = vi.fn(async () => {
      await landed;
      // A landed checkpoint holds everything the drain applied.
      inner(svc).durableApplied = inner(svc).inboundApplied;
    });
    registerMlsStatePersister({ flushEncrypted } as unknown as MlsStatePersister);
    Object.assign(svc, {
      userId: 'user-a',
      messageCallback: vi.fn(async () => true),
      delivery: {
        ackMessages: vi.fn(async (ids: string[]) => {
          acked.push(ids);
        }),
      },
    });
    const enqueue = (id: string, isCommit: boolean) =>
      (
        svc as unknown as {
          enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void;
        }
      ).enqueueMessage(
        {
          senderId: 'alice',
          ciphertext: new Uint8Array([1]),
          groupId: 'group-a',
          isWelcome: false,
          isCommit,
          queuedMessageId: id,
        },
        'live'
      );
    enqueue('msg', false);
    enqueue('commit', true);
    const scheduler = (svc as unknown as { messageScheduler: MlsPerGroupScheduler })
      .messageScheduler;
    await scheduler.waitUntilIdle();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(flushEncrypted).toHaveBeenCalled();
    expect(acked).toEqual([]);
    land();
    await (svc as unknown as { ackInFlight: Promise<void> | null }).ackInFlight;
    expect(acked).toEqual([['msg', 'commit']]);
  });
});
