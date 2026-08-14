// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { noteFrameEmitted, pendingSendGenerations } from '$lib/mls-client/sendRatchetLedger';

/**
 * THE REPAIR THAT RUNS BEFORE ANYTHING CAN SEND.
 *
 * A checkpoint is not awaited on the send path, so a reload can restore an `mls.bin` that is behind
 * frames already on the wire; re-issuing one of those generations is `SecretReuseError` and the peer
 * refuses the frame. `reconcileSendRatchets` burns the difference at load, from a count kept outside
 * the snapshot.
 *
 * What the cases below defend is not the arithmetic - `sendRatchetLedger.test.ts` owns that - but the
 * three properties this seam adds: it runs on a restore and NOT on a fresh start, one unrepairable
 * group does not cost the others their repair, and a burn is followed by the checkpoint that closes
 * the ledger (without it the next load burns the same generations again).
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    freshStart: false,
    skipSendGenerations: vi.fn().mockResolvedValue(0),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const reconcile = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as {
      reconcileSendRatchets(k: string): Promise<void>;
    }
  ).reconcileSendRatchets.call(ctx, 'key-b64');

describe('BaseMlsService.reconcileSendRatchets', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('burns nothing, and touches no disk, when the snapshot is up to date', async () => {
    const ctx = makeCtx();
    await reconcile(ctx);

    expect(ctx.skipSendGenerations).not.toHaveBeenCalled();
    expect(ctx.persistCheckpoint).not.toHaveBeenCalled();
  });

  it('burns exactly what the restored snapshot is behind, per group', async () => {
    noteFrameEmitted('u', 'g1');
    noteFrameEmitted('u', 'g1');
    noteFrameEmitted('u', 'g2');
    const ctx = makeCtx();

    await reconcile(ctx);

    expect(ctx.skipSendGenerations).toHaveBeenCalledWith('g1', 2);
    expect(ctx.skipSendGenerations).toHaveBeenCalledWith('g2', 1);
  });

  /**
   * The burn moved the live ratchet and nothing durable knows it yet. The checkpoint is what commits
   * `persisted = emitted` through the pairing in `persistCheckpoint`, so the deficit is gone
   * afterwards rather than replayed on every subsequent load.
   */
  it('checkpoints after a burn, which is what closes the ledger', async () => {
    noteFrameEmitted('u', 'g1');
    const ctx = makeCtx({
      // The real seam commits the ledger; here it is the stub's job to stand in for that effect.
      persistCheckpoint: vi.fn().mockImplementation(async () => {
        const { commitPersisted, snapshotEmitted } =
          await import('$lib/mls-client/sendRatchetLedger');
        commitPersisted('u', snapshotEmitted('u'));
      }),
    });

    await reconcile(ctx);

    expect(ctx.persistCheckpoint).toHaveBeenCalledWith('key-b64');
    expect(pendingSendGenerations('u')).toEqual([]);
  });

  /**
   * The ledger can name a conversation this device has since left or forgotten, and the platform
   * answers `GroupNotFound` for it. Isolated per group, or one dead entry costs every other
   * conversation its repair - and those are the ones a user is about to send into.
   */
  it('repairs the other groups when one of them cannot be burnt', async () => {
    noteFrameEmitted('u', 'gone');
    noteFrameEmitted('u', 'live');
    const ctx = makeCtx({
      skipSendGenerations: vi.fn().mockImplementation(async (groupId: string) => {
        if (groupId === 'gone') throw new Error('GroupNotFound');
        return 1;
      }),
    });

    await reconcile(ctx);

    expect(ctx.skipSendGenerations).toHaveBeenCalledWith('live', 1);
    expect(ctx.persistCheckpoint).toHaveBeenCalled();
  });

  it('does not checkpoint when every burn failed - there is nothing new to persist', async () => {
    noteFrameEmitted('u', 'gone');
    const ctx = makeCtx({
      skipSendGenerations: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
    });

    await reconcile(ctx);

    expect(ctx.persistCheckpoint).not.toHaveBeenCalled();
  });

  /**
   * A fresh start has no history to repair, and any surviving count describes a device that no
   * longer exists: its ratchets begin at generation zero, so burning against them would skip
   * generations no peer is waiting for.
   */
  it('drops the ledger instead of replaying it on a fresh start', async () => {
    noteFrameEmitted('u', 'g1');
    const ctx = makeCtx({ freshStart: true });

    await reconcile(ctx);

    expect(ctx.skipSendGenerations).not.toHaveBeenCalled();
    expect(pendingSendGenerations('u')).toEqual([]);
  });
});
