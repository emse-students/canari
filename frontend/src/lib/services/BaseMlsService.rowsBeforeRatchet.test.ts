// @vitest-environment happy-dom
// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
/** Whether this tab leads - read by the gate at the start and by the latch at the put. */
const tab = vi.hoisted(() => ({ leads: true }));
vi.mock('$lib/mls-client/stateAuthority', async (original) => ({
  ...(await original<typeof import('$lib/mls-client/stateAuthority')>()),
  refusesCommitsHere: () => !tab.leads,
}));

const stagePendingHistoryMarks = vi.hoisted(() => vi.fn(() => 0));
vi.mock('$lib/utils/chat/history', () => ({
  stagePendingHistoryMarks,
  forgetSeenCipherCaches: vi.fn(),
  noteFrameConsumed: vi.fn(),
}));

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { closeMlsDb } from '$lib/utils/hex';
import { MlsCheckpointNotWrittenError } from '$lib/utils/hex';
import { hydrateStateLedgers, resetStateLedgersForTests } from '$lib/mls-client/stateLedgers';
import { BaseMlsService } from './BaseMlsService';
import { RowsOwedLedger } from '$lib/mls-client/rowsOwed';

/**
 * ROWS BEFORE RATCHET (P1, second review of #3321): a checkpoint stores the rows held in memory for
 * frames already applied BEFORE it exports their ratchet advance, and keeps the hold until its write
 * settled. A kill between an export and the window's close used to lose those messages for good.
 */
const U = 'u';

function makeCtx(observers: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    userId: U,
    currentDeviceKeyB64: 'k',
    inboundApplied: 0,
    durableApplied: 0,
    bulkIngestObservers: observers,
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    sendRatchetsNotDurable: BaseMlsService.prototype['sendRatchetsNotDurable'],
    stageCheckpointLedgers: BaseMlsService.prototype['stageCheckpointLedgers'],
    emittedForCheckpoint: BaseMlsService.prototype['emittedForCheckpoint'],
    holdRowsForExport: BaseMlsService.prototype['holdRowsForExport'],
    rowsOwed: new RowsOwedLedger(),
    ...overrides,
  };
}

const persist = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as { persistCheckpoint(): Promise<void> }
  ).persistCheckpoint.call(ctx);

describe('BaseMlsService.persistCheckpoint - rows before ratchet', () => {
  beforeEach(async () => {
    await closeMlsDb();
    globalThis.indexedDB = new IDBFactory();
    resetStateLedgersForTests();
    hydrateStateLedgers(U, {});
    tab.leads = true;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores the held rows BEFORE the export, and releases the hold only once the write settled', async () => {
    const order: string[] = [];
    const observer = {
      onBulkIngestStart: vi.fn(),
      onBulkIngestEnd: vi.fn(),
      holdRowsForCheckpoint: vi.fn(async () => {
        await Promise.resolve();
        order.push('rows stored');
        return () => order.push('released');
      }),
    };
    const ctx = makeCtx([observer], {
      writeCheckpoint: vi.fn(async () => {
        order.push('export');
        await Promise.resolve();
        order.push('written');
      }),
    });

    await persist(ctx);

    expect(order).toEqual(['rows stored', 'export', 'written', 'released']);
  });

  it('releases the hold when the write FAILS too', async () => {
    const release = vi.fn();
    const observer = {
      onBulkIngestStart: vi.fn(),
      onBulkIngestEnd: vi.fn(),
      holdRowsForCheckpoint: vi.fn(async () => release),
    };
    const ctx = makeCtx([observer], {
      writeCheckpoint: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });

    await expect(persist(ctx)).rejects.toThrow('quota exceeded');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('REFUSES the checkpoint when the rows could not be stored: the state stays behind them, nothing exported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstRelease = vi.fn();
    const ctx = makeCtx([
      {
        onBulkIngestStart: vi.fn(),
        onBulkIngestEnd: vi.fn(),
        holdRowsForCheckpoint: async () => firstRelease,
      },
      {
        onBulkIngestStart: vi.fn(),
        onBulkIngestEnd: vi.fn(),
        holdRowsForCheckpoint: async () => {
          throw new Error('store closed');
        },
      },
    ]);

    await expect(persist(ctx)).rejects.toBeInstanceOf(MlsCheckpointNotWrittenError);
    expect(ctx.writeCheckpoint).not.toHaveBeenCalled();
    // The hold already taken is given back: the other observer buffers again.
    expect(firstRelease).toHaveBeenCalledTimes(1);
  });

  it('an observer that holds no rows (the persister) is not asked', async () => {
    const ctx = makeCtx([{ onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn() }]);
    await persist(ctx);
    expect(ctx.writeCheckpoint).toHaveBeenCalledTimes(1);
  });
  /** Lets every pending continuation run, so "not yet" below means blocked, not slow. */
  const drainMicrotasks = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('THE DECRYPT HALF: waits for a frame between its decrypt and its row, THEN stores the buffered rows, THEN exports', async () => {
    const order: string[] = [];
    const rowsOwed = new RowsOwedLedger();
    // A handler that decrypted and has not stored its row yet.
    const settleRow = await rowsOwed.owe();
    const observer = {
      onBulkIngestStart: vi.fn(),
      onBulkIngestEnd: vi.fn(),
      holdRowsForCheckpoint: vi.fn(async () => {
        order.push('buffered rows stored');
        return () => order.push('rows released');
      }),
    };
    const ctx = makeCtx([observer], {
      rowsOwed,
      writeCheckpoint: vi.fn(async () => {
        order.push('export');
      }),
    });

    const checkpoint = persist(ctx);
    // The hold is taken once the send counts are read (IndexedDB): polled, never timed.
    await vi.waitFor(() => expect(rowsOwed['holds']).toBe(1));
    await drainMicrotasks();
    // Nothing is exported, nor are the buffers asked, while the row is owed.
    expect(order).toEqual([]);
    order.push('row written');
    settleRow();
    await checkpoint;

    expect(order).toEqual(['row written', 'buffered rows stored', 'export', 'rows released']);
  });

  it('THE DECRYPT HALF: a frame that asks to decrypt while the checkpoint runs waits until its write settled', async () => {
    const rowsOwed = new RowsOwedLedger();
    let finishWrite!: () => void;
    const ctx = makeCtx([], {
      rowsOwed,
      writeCheckpoint: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          })
      ),
    });

    const checkpoint = persist(ctx);
    // The send counts are read from IndexedDB first: polled, never timed.
    await vi.waitFor(() => expect(ctx.writeCheckpoint).toHaveBeenCalledTimes(1));
    let decrypting = false;
    const mark = rowsOwed.owe().then((settleRow) => {
      decrypting = true;
      return settleRow;
    });
    await drainMicrotasks();
    // NATIVE (no capture at the call): on native the export runs inside the command: the decrypt waits for the whole write.
    expect(decrypting).toBe(false);
    finishWrite();
    await checkpoint;
    await drainMicrotasks();
    expect(decrypting).toBe(true);
    (await mark)();
  });

  it('THE DECRYPT HALF, ON THE WEB: the decrypts resume at the CAPTURE, never behind a slow seal and put', async () => {
    const rowsOwed = new RowsOwedLedger();
    let finishWrite!: () => void;
    const ctx = makeCtx([], {
      rowsOwed,
      // The web's `save_state` runs in the call's synchronous part.
      checkpointCapturesAtCall: true,
      writeCheckpoint: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          })
      ),
    });

    const checkpoint = persist(ctx);
    await vi.waitFor(() => expect(ctx.writeCheckpoint).toHaveBeenCalledTimes(1));
    let decrypting = false;
    const mark = rowsOwed.owe().then((settleRow) => {
      decrypting = true;
      return settleRow;
    });
    await drainMicrotasks();
    // The write is still sealing: the decrypt went through all the same.
    expect(decrypting).toBe(true);
    (await mark)();
    finishWrite();
    await checkpoint;
  });

  it('THE DECRYPT HALF: reopens the gate when the checkpoint is refused or fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rowsOwed = new RowsOwedLedger();
    const ctx = makeCtx(
      [
        {
          onBulkIngestStart: vi.fn(),
          onBulkIngestEnd: vi.fn(),
          holdRowsForCheckpoint: async () => {
            throw new Error('store closed');
          },
        },
      ],
      { rowsOwed }
    );

    await expect(persist(ctx)).rejects.toBeInstanceOf(MlsCheckpointNotWrittenError);
    const settleRow = await rowsOwed.owe();
    expect(rowsOwed.owedCount).toBe(1);
    settleRow();
  });
});
