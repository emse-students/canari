// @vitest-environment happy-dom
// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

// The history marks are staged by `history.ts`; here they are a stand-in that stages ONE known mark,
// so a case can follow it into the write.
const stagePendingHistoryMarks = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/history', () => ({
  stagePendingHistoryMarks,
  forgetSeenCipherCaches: vi.fn(),
  noteFrameConsumed: vi.fn(),
}));

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { closeMlsDb } from '$lib/utils/hex';
import { noteFrameEmitted } from '$lib/mls-client/sendRatchetLedger';
import {
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  stageStateLedger,
  STATE_LEDGER,
  takeStagedStateLedgers,
  type StateLedgerChanges,
} from '$lib/mls-client/stateLedgers';
import { BaseMlsService } from './BaseMlsService';

/**
 * ONE WRITE, AND THE LEDGERS THAT DESCRIBE THE STATE TRAVEL INSIDE IT (KILL-2, 2026-10-26).
 *
 * `persistCheckpoint` is the single place this device's state becomes durable, so it is the single
 * place that may declare something durable. Two ledgers depend on that declaration: the send ledger's
 * `persisted` counts and the history replay's marks. Until 2026-10-26 they were written to
 * `localStorage` AFTER the write - the survivable order of two stores, and a window as long as the
 * seconds `localStorage` waits before it reaches the disk. A browser killed in it kept the ratchet
 * and lost the marks, and the next walk accused a frame it had read of being lost.
 *
 * These cases defend the seam: the ledgers are staged BEFORE the write and handed TO it, in the same
 * call; a write that fails keeps them for the next one; and nothing is staged before the state opened.
 */
const U = 'u';
const SEEN = STATE_LEDGER.seen('g');

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: U,
    currentDeviceKeyB64: 'k',
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    // The real exclusion of the ratchets whose repair is still owed (none here).
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    sendRatchetsNotDurable: BaseMlsService.prototype['sendRatchetsNotDurable'],
    stageCheckpointLedgers: BaseMlsService.prototype['stageCheckpointLedgers'],
    emittedForCheckpoint: BaseMlsService.prototype['emittedForCheckpoint'],
    ...overrides,
  };
}

const persist = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as { persistCheckpoint(): Promise<void> }
  ).persistCheckpoint.call(ctx);

/** The ledgers the write was handed - its third argument. */
const handed = (ctx: { writeCheckpoint: ReturnType<typeof vi.fn> }, call = 0) =>
  ctx.writeCheckpoint.mock.calls[call][2] as StateLedgerChanges | undefined;

describe('BaseMlsService.persistCheckpoint', () => {
  beforeEach(async () => {
    await closeMlsDb();
    globalThis.indexedDB = new IDBFactory();
    resetStateLedgersForTests();
    hydrateStateLedgers(U, {});
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stagePendingHistoryMarks.mockImplementation((userId: string) => {
      stageStateLedger(userId, SEEN, JSON.stringify(['fp-read']));
      return 1;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands the marks and the send counts TO the write that makes the ratchet durable', async () => {
    await noteFrameEmitted(U, 'g', 3);
    const ctx = makeCtx();

    await persist(ctx);

    // With this document's write latch, read at the put (`BaseMlsService.deviceRevoked.test.ts`).
    expect(ctx.writeCheckpoint).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({ isEnded: expect.any(Function) }),
      {
        [SEEN]: JSON.stringify(['fp-read']),
        [STATE_LEDGER.sendPersisted]: JSON.stringify({ 'g@3': 1 }),
      }
    );
    expect(stagePendingHistoryMarks).toHaveBeenCalledWith(U);
  });

  it('stages them BEFORE the write starts - a mark made while it runs is not in it', async () => {
    // The native checkpoint releases the manager once it has exported (2026-10-13), so a replay page
    // can decrypt and mark while the seal and the write run. That mark describes an advance this
    // write does not hold; it stays staged for the next checkpoint.
    const ctx = makeCtx({
      writeCheckpoint: vi.fn().mockImplementation(async () => {
        stageStateLedger(U, STATE_LEDGER.seen('later'), '["fp-later"]');
      }),
    });

    await persist(ctx);

    expect(handed(ctx)).not.toHaveProperty(STATE_LEDGER.seen('later'));
    expect(takeStagedStateLedgers(U)).toEqual({ [STATE_LEDGER.seen('later')]: '["fp-later"]' });
  });

  it('keeps every ledger it handed to a write that FAILED, for the next checkpoint', async () => {
    // A failed write left the state where it was; the client may or may not have taken the values.
    // Re-applying one it took is a no-op, so the next checkpoint carries them all.
    stagePendingHistoryMarks.mockImplementationOnce((userId: string) => {
      stageStateLedger(userId, SEEN, JSON.stringify(['fp-read']));
      return 1;
    });
    stagePendingHistoryMarks.mockImplementation(() => 0);
    const failing = makeCtx({
      writeCheckpoint: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });

    await expect(persist(failing)).rejects.toThrow('quota exceeded');

    const next = makeCtx();
    await persist(next);
    expect(handed(next)).toEqual({ [SEEN]: JSON.stringify(['fp-read']) });
  });

  it('restages the CURRENT value, not the failed batch, when a key moved since', async () => {
    const failing = makeCtx({
      writeCheckpoint: vi.fn().mockImplementation(async () => {
        stageStateLedger(U, SEEN, JSON.stringify(['fp-read', 'fp-newer']));
        throw new Error('quota exceeded');
      }),
    });

    await expect(persist(failing)).rejects.toThrow('quota exceeded');

    expect(takeStagedStateLedgers(U)).toEqual({ [SEEN]: JSON.stringify(['fp-read', 'fp-newer']) });
  });

  it('stages nothing before the state opened - the load reads what the state carries', async () => {
    resetStateLedgersForTests();
    const ctx = makeCtx();

    await persist(ctx);

    expect(handed(ctx)).toBeUndefined();
    expect(stagePendingHistoryMarks).not.toHaveBeenCalled();
  });

  it('still writes the state when the send counts cannot be read, declaring no send durable', async () => {
    // Refusing the checkpoint over a counter would lose every ratchet advance since the last one;
    // declaring nothing costs the next load an over-burn, which is free.
    await closeMlsDb();
    const broken = new IDBFactory();
    broken.open = () => {
      throw new DOMException('Internal error', 'UnknownError');
    };
    globalThis.indexedDB = broken;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx();

    await persist(ctx);

    expect(handed(ctx)).toEqual({ [SEEN]: JSON.stringify(['fp-read']) });
    expect(readStateLedger(U, STATE_LEDGER.sendPersisted)).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('never declares durable a ratchet whose burn is still owed', async () => {
    await noteFrameEmitted(U, 'g', 5);
    const ctx = makeCtx({ owedSendBurns: new Map([['g', new Map([[5, 1]])]]) });

    await persist(ctx);

    expect(handed(ctx)).not.toHaveProperty(STATE_LEDGER.sendPersisted);
  });
});
