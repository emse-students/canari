// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const commitPendingHistoryMarks = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/history', () => ({
  commitPendingHistoryMarks,
  noteFrameConsumed: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';

/**
 * ONE WRITE, TWO LEDGERS, AND THE ORDER IS THE WHOLE PROPERTY.
 *
 * `persistCheckpoint` is the single place this device's state becomes durable, so it is the single
 * place that may DECLARE something durable. Two ledgers depend on that declaration: the send ledger
 * (what this device has already put on the wire) and the history replay's marks (which archive frames
 * it has already consumed). The second was bound to the wrong event until 2026-09-08 - it became
 * durable only in the thunk at the END of the archive walk, so a checkpoint landing mid-walk made the
 * ratchet durable while the marks were still in memory, and a page killed there re-accused frames it
 * had really read.
 *
 * These cases defend the seam rather than either ledger's arithmetic: that the declaration happens at
 * all, that it happens AFTER the write, and that a write which FAILED declares nothing. The last is
 * the one that matters most and is the easiest to lose in a refactor - the two orderings are not
 * symmetric. A ledger ahead of a ratchet skips a message for good; a ratchet ahead of a ledger only
 * re-accuses one.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    currentDeviceKeyB64: 'k',
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const persist = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as { persistCheckpoint(): Promise<void> }
  ).persistCheckpoint.call(ctx);

describe('BaseMlsService.persistCheckpoint', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('declares the replay marks durable once the checkpoint has been written', async () => {
    const ctx = makeCtx();

    await persist(ctx);

    expect(ctx.writeCheckpoint).toHaveBeenCalledWith('k');
    expect(commitPendingHistoryMarks).toHaveBeenCalledWith('u');
  });

  it('declares them AFTER the write, never before', async () => {
    // The direction the whole seam rests on. Declaring first would make the ledger durable while the
    // ratchet advance it describes might never land - and that reload SKIPS the frame rather than
    // re-reading it, which is the one failure this design refuses to trade for.
    const order: string[] = [];
    const ctx = makeCtx({
      writeCheckpoint: vi.fn().mockImplementation(async () => {
        order.push('write');
      }),
    });
    commitPendingHistoryMarks.mockImplementation(() => {
      order.push('commit');
    });

    await persist(ctx);

    expect(order).toEqual(['write', 'commit']);
  });

  it('declares NOTHING when the checkpoint write fails', async () => {
    // A failed write left the ratchet where it was. Marking the frames consumed anyway would tell
    // the next load to skip frames whose generation was never spent.
    const ctx = makeCtx({
      writeCheckpoint: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });

    await expect(persist(ctx)).rejects.toThrow('quota exceeded');
    expect(commitPendingHistoryMarks).not.toHaveBeenCalled();
  });

  it('names the account it is checkpointing, so another session is never declared for', async () => {
    await persist(makeCtx({ userId: 'someone-else' }));

    expect(commitPendingHistoryMarks).toHaveBeenCalledWith('someone-else');
  });
});
