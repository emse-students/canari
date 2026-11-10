// @vitest-environment happy-dom
// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const commitPendingHistoryMarks = vi.hoisted(() => vi.fn());
const snapshotPendingHistoryMarks = vi.hoisted(() =>
  vi.fn((userId: string) => ({ userId, groups: [] }))
);
vi.mock('$lib/utils/chat/history', () => ({
  commitPendingHistoryMarks,
  snapshotPendingHistoryMarks,
  noteFrameConsumed: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';
import { MlsStateWriteRefusedError, type MlsStateWriteLatch } from '$lib/utils/hex';

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
    // The real exclusion of the ratchets whose repair is still owed (none here).
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    sendRatchetsNotDurable: BaseMlsService.prototype['sendRatchetsNotDurable'],
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

    // With this document's write latch, read at the put (`BaseMlsService.deviceRevoked.test.ts`).
    expect(ctx.writeCheckpoint).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({ isEnded: expect.any(Function) })
    );
    expect(commitPendingHistoryMarks).toHaveBeenCalledWith({ userId: 'u', groups: [] });
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

    expect(snapshotPendingHistoryMarks).toHaveBeenCalledWith('someone-else');
    expect(commitPendingHistoryMarks).toHaveBeenCalledWith({ userId: 'someone-else', groups: [] });
  });

  it('declares the marks that stood BEFORE the write started, not those made while it ran', async () => {
    // The native checkpoint releases the manager once it has exported (2026-10-13), so a replay page
    // can decrypt and mark while the seal and the write run. Those marks describe an advance this
    // write does not hold; only the set captured before it may be declared.
    const order: string[] = [];
    const before = { userId: 'u', groups: [] };
    snapshotPendingHistoryMarks.mockImplementationOnce(() => {
      order.push('snapshot');
      return before;
    });
    const ctx = makeCtx({
      writeCheckpoint: vi.fn().mockImplementation(async () => {
        order.push('write');
      }),
    });
    commitPendingHistoryMarks.mockImplementation(() => {
      order.push('commit');
    });

    await persist(ctx);

    expect(order).toEqual(['snapshot', 'write', 'commit']);
    expect(commitPendingHistoryMarks).toHaveBeenCalledWith(before);
  });
});

/**
 * ONLY THE LEADER COPY IS WRITTEN (2026-11-10). Production `1.6.9`: a follower tab checkpointed its
 * own copy five times in nine minutes, and the leader's writes were then refused as stale behind it.
 */
describe('BaseMlsService.persistCheckpoint in a tab without the leader copy', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    resetStateAuthorityForTests();
  });

  it('writes nothing, declares nothing, and rejects typed', async () => {
    noteMlsStateLoaded(false);
    const ctx = makeCtx();

    await expect(persist(ctx)).rejects.toEqual(new MlsStateWriteRefusedError('not-leader'));

    expect(ctx.writeCheckpoint).not.toHaveBeenCalled();
    expect(commitPendingHistoryMarks).not.toHaveBeenCalled();
  });

  it('accuses the caller once, however often it is asked', async () => {
    noteMlsStateLoaded(false);
    const ctx = makeCtx();

    await persist(ctx).catch(() => undefined);
    await persist(ctx).catch(() => undefined);

    const accusations = error.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('does not hold the leader copy')
    );
    expect(accusations).toHaveLength(1);
  });

  it('hands the write a latch that reads the lead AT THE PUT, so a lead lost mid-seal is seen', async () => {
    noteMlsStateLoaded(true);
    let atThePut: boolean | undefined;
    const ctx = makeCtx({
      writeCheckpoint: vi
        .fn()
        .mockImplementation(async (_key: string, latch: MlsStateWriteLatch) => {
          // The lead leaves this document while the capture is sealing.
          noteMlsStateLoaded(false);
          atThePut = latch.holdsNoLead?.();
        }),
    });

    await persist(ctx);

    expect(atThePut).toBe(true);
  });

  /**
   * Review of #3326: the rotation used to meet `not-leader` at its checkpoint, after it had moved the
   * id and loaded a fresh client - which latched the document and sent it into the refused-rotation
   * reload. Refused before anything moves, there is nothing to end.
   */
  it('refuses a device identity rotation before it moves anything', async () => {
    noteMlsStateLoaded(false);
    const ctx = {
      ...makeCtx(),
      deviceId: 'dev-kept',
      stateWritesEnded: false,
      generateDeviceId: vi.fn(() => 'dev-fresh'),
      loadFreshStateReplacingUnopened: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      (
        BaseMlsService.prototype as unknown as {
          rotateDeviceIdentity(key: string, reason: string): Promise<string>;
        }
      ).rotateDeviceIdentity.call(ctx, 'k', 'a test')
    ).rejects.toEqual(new MlsStateWriteRefusedError('not-leader'));
    warn.mockRestore();

    expect(ctx.deviceId).toBe('dev-kept');
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
    expect(ctx.loadFreshStateReplacingUnopened).not.toHaveBeenCalled();
    expect(ctx.stateWritesEnded).toBe(false);
    expect(ctx.writeCheckpoint).not.toHaveBeenCalled();
  });
});
