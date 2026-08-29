// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { isInEpochGap, resetEpochGapRegistry } from '$lib/utils/chat/epochGapRegistry';

/**
 * The WRITE-side entrance to the recovery ladder: a commit the server refuses because our base
 * epoch is behind its active one.
 *
 * **THIS IS A REGRESSION TEST FOR A DEFECT THAT RAN IN PRODUCTION FOR HOURS.** Both rungs of the
 * ladder were reachable only from the read side - an incoming frame this device cannot decrypt - so
 * a device that was behind on a QUIET conversation never entered it. The rejection was documented as
 * retryable, and the retry rested on a premise nothing established: that the commit we missed would
 * arrive on its own. On two conversations whose only remaining traffic was our own refused commits,
 * it never did, and the same commit was refused 191 and 172 times in twenty-four hours.
 *
 * So the cases below are about WHERE THE LADDER IS ENTERED FROM, not about what the rungs then do
 * (`commitReplay.test.ts` owns that). The real `attemptCommitReplay` runs here, against stubbed
 * primitives, because a mock of it would keep passing after the wiring under test broke.
 */
type Ctx = ReturnType<typeof makeCtx>;

function makeCtx(overrides: Record<string, unknown> = {}) {
  // One mutable epoch, read by `freshEpoch` (the commit gate) and `getEpoch` (the replay), advanced
  // by applying a commit - so "did the replay actually catch us up" is a fact and not a mock's say-so.
  const state = { epoch: 195 };
  return {
    state,
    delivery: {
      submitCommit: vi.fn(),
      fetchCommitsSince: vi.fn(),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn(async () => state.epoch),
    getEpoch: vi.fn(() => state.epoch),
    fetchCommitsSince: vi.fn(),
    processIncomingMessage: vi.fn(async () => {
      state.epoch += 1;
      return null;
    }),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    exportRatchetTree: vi.fn().mockResolvedValue(new Uint8Array([1])),
    refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    // The REAL method, not a stand-in: it IS the entrance under test.
    catchUpOnRefusedCommit: (
      BaseMlsService.prototype as unknown as {
        catchUpOnRefusedCommit: (g: string, b: number, a: number | undefined) => Promise<void>;
      }
    ).catchUpOnRefusedCommit,
    ...overrides,
  };
}

const runCommit = (ctx: Ctx, groupId: string) =>
  (
    BaseMlsService.prototype as unknown as {
      runCommitTransaction: (
        g: string,
        stageFn: () => Promise<{ commit: Uint8Array }>,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
    }
  ).runCommitTransaction.call(ctx, groupId, async () => ({ commit: new Uint8Array([1, 2, 3]) }));

describe('BaseMlsService - a commit refused for a stale epoch', () => {
  beforeEach(() => resetEpochGapRegistry());

  it('replays the commits it missed, so the retry the caller is told to make can succeed', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'epoch_mismatch',
      currentEpoch: 196,
    });
    ctx.fetchCommitsSince.mockResolvedValue({
      commits: [{ baseEpoch: 195, proto: 'AQID' }],
      activeEpoch: 196,
      belowFloor: false,
    });

    // The refusal is still reported: catching up is not succeeding, and the caller must not read it
    // as a commit that landed.
    await expect(runCommit(ctx, 'g')).rejects.toThrow('Staged commit rejected: epoch_mismatch');

    expect(ctx.fetchCommitsSince).toHaveBeenCalledWith('g', 195);
    expect(ctx.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(ctx.state.epoch).toBe(196);
    // Gap closed: the outbox must not stay frozen on a group that is now up to date.
    expect(isInEpochGap('g')).toBe(false);
  });

  it('leaves the group in the epoch-gap registry when rung 1 cannot close it, for the watchdog', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'epoch_mismatch',
      currentEpoch: 400,
    });
    // Commits pruned past retention: rung 1 is powerless and says so.
    ctx.fetchCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 400, belowFloor: true });

    await expect(runCommit(ctx, 'g')).rejects.toThrow('Staged commit rejected');

    expect(ctx.processIncomingMessage).not.toHaveBeenCalled();
    // Rung 2 belongs to the sync watchdog, which owns the re-add cadence. The registry entry is how
    // it learns there is anything to escalate - and freezes the outbox until it does.
    expect(isInEpochGap('g')).toBe(true);
  });

  it('does nothing when the refusal reports no epoch ahead of ours - the epochs decide, not the reason', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: false, reason: 'not_a_member' });

    await expect(runCommit(ctx, 'g')).rejects.toThrow('Staged commit rejected: not_a_member');

    expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
    expect(isInEpochGap('g')).toBe(false);
  });

  it('never enters the ladder on an accepted commit', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 196 });

    await runCommit(ctx, 'g');

    expect(ctx.mergePendingCommit).toHaveBeenCalledWith('g');
    expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
    expect(isInEpochGap('g')).toBe(false);
  });
});
