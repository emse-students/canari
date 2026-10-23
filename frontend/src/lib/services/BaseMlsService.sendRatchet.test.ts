// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn(),
  scheduleOutboundMlsPersist: vi.fn(),
  noteInboundMlsFrame: vi.fn(),
}));

import type { Mock } from 'vitest';
import { BaseMlsService } from './BaseMlsService';
import {
  commitPersisted,
  noteFrameEmitted,
  sendRatchetEntries,
  snapshotEmitted,
} from '$lib/mls-client/sendRatchetLedger';
import { sealedFrame } from '$lib/mls-client/test/sealedFrame';
import { DELIVERY } from '$lib/mls-client/frameDelivery';

/**
 * THE REPAIR THAT RUNS BEFORE ANYTHING CAN SEND, AND THE EPOCH IT RUNS IN.
 *
 * A checkpoint is not awaited on the send path, so a reload can restore an `mls.bin` that is behind
 * frames already on the wire; re-issuing one of those generations is `SecretReuseError` and the peer
 * refuses the frame. `reconcileSendRatchets` burns the difference at load, from a count kept outside
 * the snapshot - and a generation belongs to ONE epoch's ratchet, so the burn must land in the epoch
 * the frames were counted in.
 *
 * The platform is a MODEL of an openmls send ratchet - one generation counter per epoch, a merge
 * starting the next epoch at 0, the same secrets for the same staged commit merged twice - and the
 * peer remembers every (epoch, generation) it consumed. `mls-core/tests/burn_spent_generations.rs`
 * pins the model's premises against two real clients.
 */

const U = 'u';
const G = 'g-1';

/** What a checkpoint holds of the model, and what a reload restores. */
interface ModelState {
  epoch: number;
  next: Record<number, number>;
}

/** One device's MLS client as the ratchet sees it. */
class RatchetModel {
  constructor(public state: ModelState = { epoch: 4, next: {} }) {}
  snapshot(): ModelState {
    return { epoch: this.state.epoch, next: { ...this.state.next } };
  }
  seal(): Uint8Array {
    const { epoch } = this.state;
    const gen = this.state.next[epoch] ?? 0;
    this.state.next[epoch] = gen + 1;
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, gen);
    return sealedFrame(epoch, G, tail);
  }
  burn(count: number): void {
    const { epoch } = this.state;
    this.state.next[epoch] = (this.state.next[epoch] ?? 0) + count;
  }
  /** The staged commit merges: a new epoch, its ratchet at generation 0. */
  merge(): void {
    this.state.epoch += 1;
    this.state.next[this.state.epoch] = 0;
  }
}

/** The peer: every (epoch, generation) it consumed, and every frame that re-used one. */
class Peer {
  readonly consumed = new Set<string>();
  readonly reused: string[] = [];
  receive(frame: Uint8Array): void {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const idLength = frame[4];
    const epoch = Number(view.getBigUint64(5 + idLength));
    const gen = view.getUint32(5 + idLength + 8);
    const key = `${epoch}:${gen}`;
    if (this.consumed.has(key)) this.reused.push(key);
    this.consumed.add(key);
  }
}

/**
 * One app session over `model`: the real `reconcileSendRatchets` and `sendMessage`, the platform
 * primitives answered by the model, and a checkpoint that makes the model durable and commits the
 * ledger the way `persistCheckpoint` does.
 */
function session(model: RatchetModel, peer: Peer, disk: { state: ModelState }) {
  const svc = Object.create(BaseMlsService.prototype) as Record<string, unknown>;
  Object.assign(svc, {
    userId: U,
    deviceId: 'd',
    freshStart: false,
    liveMutations: 0,
    owedSendBurns: new Map(),
    unresolvedGroups: new Set<string>(),
    catchUpGate: null,
    getLocalGroups: () => [G],
    freshEpoch: vi.fn(async () => model.state.epoch),
    getEpoch: () => model.state.epoch,
    encryptForSend: vi.fn(async () => model.seal()),
    skipSendGenerations: vi.fn(async (_g: string, count: number) => {
      model.burn(count);
      return count;
    }),
    persistCheckpoint: vi.fn(async () => {
      const emitted = snapshotEmitted(U);
      disk.state = model.snapshot();
      commitPersisted(U, emitted);
    }),
    waitForCatchUpIdle: async () => {},
    scheduleLeafRefresh: () => {},
    delivery: {
      postApplicationMessage: vi.fn(async (_g: string, proto: string) => {
        peer.receive(Uint8Array.from(atob(proto), (c) => c.charCodeAt(0)));
        return null;
      }),
    },
  });
  const typed = svc as unknown as {
    reconcileSendRatchets(): Promise<void>;
    sendMessage(g: string, b: Uint8Array, id?: string, d?: unknown): Promise<unknown>;
    skipSendGenerations: Mock<(groupId: string, count: number) => Promise<number>>;
    persistCheckpoint: Mock<() => Promise<void>>;
    delivery: { postApplicationMessage: Mock<(...a: unknown[]) => Promise<unknown>> };
    encryptForSend: Mock<(...a: unknown[]) => Promise<Uint8Array>>;
  };
  return {
    svc: typed,
    send: () => typed.sendMessage(G, new Uint8Array([1]), undefined, DELIVERY.visible),
  };
}

describe('BaseMlsService.reconcileSendRatchets', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * THE REVIEW'S CASE (2026-10-23): a commit staged and checkpointed, sent, merged; frames sent in
   * the epoch it created; a crash before any checkpoint holds the merge. The reload restores the
   * STAGE, the settle merges it again - the same epoch, its ratchet back at generation 0 - and the
   * peers have consumed generations 0 and 1 there. Burnt in the restored epoch, as the ledger did
   * when it counted per group, the burn moved a ratchet nobody reads and the next frame re-issued
   * generation 0.
   */
  it('a merge after the reload starts its epoch at 0, so the frames sent there are burnt THERE', async () => {
    const peer = new Peer();
    const disk = { state: { epoch: 4, next: {} } as ModelState };
    const before = new RatchetModel();
    const first = session(before, peer, disk);
    await first.send(); // epoch 4, generation 0
    await first.svc.persistCheckpoint(); // the checkpoint awaited before the commit's first request
    before.merge(); // accepted and merged - no checkpoint after it
    await first.send(); // epoch 5, generation 0
    await first.send(); // epoch 5, generation 1
    // The crash: everything after the stage checkpoint is gone from the state, not from the ledger.

    const after = new RatchetModel(disk.state);
    const second = session(after, peer, disk);
    await second.svc.reconcileSendRatchets();
    after.merge(); // the settle: the resubmission is answered a duplicate, and the stage merges
    await second.send();

    expect(peer.reused).toEqual([]);
  });

  it('burns what the restored epoch is behind at load, and checkpoints to close the ledger', async () => {
    const peer = new Peer();
    const disk = { state: { epoch: 4, next: {} } as ModelState };
    const before = new RatchetModel();
    const first = session(before, peer, disk);
    await first.send();
    await first.send();

    const after = new RatchetModel(disk.state);
    const second = session(after, peer, disk);
    await second.svc.reconcileSendRatchets();

    expect(second.svc.skipSendGenerations).toHaveBeenCalledWith(G, 2);
    expect(second.svc.persistCheckpoint).toHaveBeenCalledTimes(1);
    await second.send();
    expect(peer.reused).toEqual([]);
  });

  /**
   * An incoming commit is not held off by the send barrier, so the group can reach an epoch that
   * still owes a burn between the burn and the encrypt. That frame is never posted: the burn is spent
   * and the frame sealed again.
   */
  it('never posts a frame sealed at an epoch that still owed a burn', async () => {
    const peer = new Peer();
    const disk = { state: { epoch: 4, next: {} } as ModelState };
    const before = new RatchetModel();
    const first = session(before, peer, disk);
    await first.svc.persistCheckpoint();
    before.merge();
    await first.send(); // epoch 5, generations 0 and 1
    await first.send();

    const after = new RatchetModel(disk.state);
    const second = session(after, peer, disk);
    await second.svc.reconcileSendRatchets();
    // The incoming commit lands between the epoch read and the first encrypt.
    const seal = second.svc.encryptForSend.getMockImplementation()!;
    second.svc.encryptForSend.mockImplementationOnce(async (...a: unknown[]) => {
      after.merge();
      return seal(...a);
    });
    await second.send();

    expect(peer.reused).toEqual([]);
    expect(second.svc.delivery.postApplicationMessage).toHaveBeenCalledTimes(1);
  });

  it('forgets epochs the restored state is past, and groups it does not hold', async () => {
    noteFrameEmitted(U, G, 2);
    noteFrameEmitted(U, 'g-gone', 7);
    const peer = new Peer();
    const disk = { state: { epoch: 4, next: {} } as ModelState };
    const { svc } = session(new RatchetModel(), peer, disk);

    await svc.reconcileSendRatchets();

    expect(svc.skipSendGenerations).not.toHaveBeenCalled();
    expect(sendRatchetEntries(U)).toEqual([]);
  });

  it('burns nothing, and touches no disk, when the snapshot is up to date', async () => {
    const { svc } = session(new RatchetModel(), new Peer(), { state: { epoch: 4, next: {} } });
    await svc.reconcileSendRatchets();

    expect(svc.skipSendGenerations).not.toHaveBeenCalled();
    expect(svc.persistCheckpoint).not.toHaveBeenCalled();
  });

  /**
   * The ledger can name a conversation the platform cannot burn in. Isolated per group, or one dead
   * entry costs every other conversation its repair.
   */
  it('repairs the other groups when one of them cannot be burnt', async () => {
    noteFrameEmitted(U, 'g-broken', 4);
    noteFrameEmitted(U, G, 4);
    const { svc } = session(new RatchetModel(), new Peer(), { state: { epoch: 4, next: {} } });
    (svc as unknown as { getLocalGroups: () => string[] }).getLocalGroups = () => [G, 'g-broken'];
    svc.skipSendGenerations.mockImplementation(async (groupId: string) => {
      if (groupId === 'g-broken') throw new Error('Burn error after 0/1 generation(s)');
      return 1;
    });

    await svc.reconcileSendRatchets();

    expect(svc.skipSendGenerations).toHaveBeenCalledWith(G, 1);
    expect(svc.persistCheckpoint).toHaveBeenCalled();
  });

  /**
   * A fresh start has no history to repair, and any surviving count describes a device that no
   * longer exists: its ratchets begin at generation zero, so burning against them would skip
   * generations no peer is waiting for.
   */
  it('drops the ledger instead of replaying it on a fresh start', async () => {
    noteFrameEmitted(U, G, 4);
    const { svc } = session(new RatchetModel(), new Peer(), { state: { epoch: 4, next: {} } });
    (svc as unknown as { freshStart: boolean }).freshStart = true;

    await svc.reconcileSendRatchets();

    expect(svc.skipSendGenerations).not.toHaveBeenCalled();
    expect(sendRatchetEntries(U)).toEqual([]);
  });
});
