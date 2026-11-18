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
});
