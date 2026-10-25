// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { recordingStage } from '../../test/recordingStage';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import { isInEpochGap, resetEpochGapRegistry } from '$lib/utils/chat/epochGapRegistry';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import {
  CommitRefusedError,
  SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS,
} from '$lib/mls-client/CommitRefusedError';
import { commitRateLimitRemainingMs, resetCommitRateLimit } from '$lib/mls-client/commitRateLimit';
import { CommitOutcomeUnknownError } from '$lib/mls-client/commitSubmission';
import {
  dischargeRefusedBacklog,
  noteUnackedFrame,
  refusedBacklogMark,
  resetUnackedFrames,
} from '$lib/mls-client/messagePipeline/unackedFrames';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';

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
  const recorder = recordingStage(() => state.epoch);
  return {
    state,
    recorder,
    pendingSubmission: recorder.pendingSubmission,
    delivery: {
      submitCommit: vi.fn(),
      fetchCommitsSince: vi.fn(),
    },
    ...plainCommitLock,
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
    refreshGroupInfo: vi.fn().mockResolvedValue(null),
    userId: 'user-a',
    deviceId: 'web-a',
    // No staged commit kept in the state: every commit here is answered at once.
    groupsWithPendingCommit: vi.fn(async () => []),
    // What a replay held behind a refused backlog asks for: the pull that ends the hold.
    notifyConversationAvailable: vi.fn(),
    // What a replay that applied commits announces (a lost invitation's wake): nothing waits here.
    notifyCommitsApplied: vi.fn(),
    // REAL: with no staged commit kept they settle nothing and submit once, which is the
    // case here (`BaseMlsService.unresolvedCommit.test.ts` owns the others).
    ...Object.fromEntries(
      [
        'settleUnresolvedLocked',
        'settleUnresolvedCommitFromLog',
        'checkpointStageBeforeSend',
        'submitRecorded',
        'mergeAccepted',
        'resubmitUnresolved',
      ].map((name) => [
        name,
        (BaseMlsService.prototype as unknown as Record<string, unknown>)[name],
      ])
    ),
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
        stageFn: (intent: Uint8Array) => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
    }
  ).runCommitTransaction.call(
    ctx,
    groupId,
    ctx.recorder.wrap(async () => ({
      commit: new Uint8Array([1, 2, 3]),
      groupInfo: new Uint8Array([7, 8, 9]),
    }))
  );

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

  // COMM-22: the base for the epoch a STAGED commit creates rides inside its submission, so the
  // server stores it with the advance. Nothing is minted afterwards, hence nothing is left to lose.
  it('submits the base for the epoch it creates WITH the commit, and mints nothing afterwards', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 196 });

    await runCommit(ctx, 'g');

    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
    const args = ctx.delivery.submitCommit.mock.calls[0];
    expect(args[1]).toBe(195);
    // 5th argument: base64 of [7, 8, 9], the bytes the stage step handed back.
    expect(args[4]).toBe('BwgJ');
    // The old fire-and-forget follow-up is gone: the one publisher left is the holder repair.
    expect(ctx.refreshGroupInfo).not.toHaveBeenCalled();
  });

  it('never publishes a base for a refused commit - the base only exists inside the submission', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: false, reason: 'not_a_member' });

    await expect(runCommit(ctx, 'g')).rejects.toThrow('Staged commit rejected');

    expect(ctx.refreshGroupInfo).not.toHaveBeenCalled();
  });
});

describe('BaseMlsService - a commit refused by the rate limit (429)', () => {
  beforeEach(() => {
    resetEpochGapRegistry();
    resetCommitRateLimit();
  });
  // The wait is process-wide by design, so it must not leak into the describes after this one.
  afterEach(() => resetCommitRateLimit());

  it('rolls the staged commit back and throws a typed refusal, never a loss of state', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockRejectedValue(
      new ApiRefusalError(429, 'RATE_LIMITED', 'Commit submission HTTP error (429)', {
        retryAfterMs: 30_000,
      })
    );

    const refused = await runCommit(ctx, 'g').catch((e: unknown) => e);

    // The throttler answers before the gate: the epoch did not move, so the staged commit is
    // cleared exactly as on a business refusal - left pending, it would block every later commit.
    expect(refused).toBeInstanceOf(CommitRefusedError);
    expect((refused as CommitRefusedError).reason).toBe('rate_limited');
    expect((refused as CommitRefusedError).currentEpoch).toBeUndefined();
    // The server's wait is carried as a typed field, so a sweep can stop on it.
    expect((refused as CommitRefusedError).retryAfterMs).toBeGreaterThan(29_000);
    expect(commitRateLimitRemainingMs()).toBeGreaterThan(29_000);
    expect(ctx.clearPendingCommit).toHaveBeenCalledWith('g');
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    // No epoch is known ahead of ours, so the recovery ladder is not entered.
    expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
    expect(isInEpochGap('g')).toBe(false);
  });

  const overtaken = () =>
    new ApiRefusalError(409, 'SEAT_CLAIM_OVERTAKEN', 'Commit submission HTTP error (409)');

  it('rebuilds and resubmits a commit whose seat claim an unrelated eviction overtook, so no caller sees it', async () => {
    // A pending member's own add or remove in an ordinary conversation carries a committer claim:
    // without the rebuild here it failed once, with nothing retrying it.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx();
    ctx.delivery.submitCommit
      .mockRejectedValueOnce(overtaken())
      .mockResolvedValueOnce({ accepted: true, newEpoch: 196 });
    const stageFn = vi.fn(async () => ({
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
    }));

    await (
      BaseMlsService.prototype as unknown as {
        runCommitTransaction: (
          g: string,
          s: (intent: Uint8Array) => Promise<unknown>
        ) => Promise<unknown>;
      }
    ).runCommitTransaction.call(ctx, 'g', ctx.recorder.wrap(stageFn));

    // Rolled back, staged again on the same epoch, accepted the second time.
    expect(ctx.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(stageFn).toHaveBeenCalledTimes(2);
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(ctx.mergePendingCommit).toHaveBeenCalledWith('g');
  });

  it('hands the refusal up as a typed one after its bound, every staged commit rolled back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockRejectedValue(overtaken());

    const refused = await runCommit(ctx, 'g').catch((e: unknown) => e);

    // The server refused the WHOLE commit each time before advancing anything: never a fork,
    // never a loss of state, and the caller is told a later retry meets a fresh claim.
    expect(refused).toBeInstanceOf(CommitRefusedError);
    expect((refused as CommitRefusedError).reason).toBe('seat_claim_overtaken');
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS);
    expect(ctx.clearPendingCommit).toHaveBeenCalledTimes(SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS);
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    expect(commitRateLimitRemainingMs()).toBe(0);
    expect(isInEpochGap('g')).toBe(false);
  });

  it('does not rebuild on a commit it could not roll back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = makeCtx({ clearPendingCommit: vi.fn().mockRejectedValue(new Error('locked')) });
    ctx.delivery.submitCommit.mockRejectedValue(overtaken());

    const refused = await runCommit(ctx, 'g').catch((e: unknown) => e);

    expect((refused as CommitRefusedError).reason).toBe('seat_claim_overtaken');
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
  });

  it('leaves every other failed submission as it was: unanswered is not refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx();
    const unanswered = new ApiRefusalError(502, null, 'Commit submission HTTP error (502)');
    ctx.delivery.submitCommit.mockRejectedValue(unanswered);

    // Not a refusal: the same commit is resubmitted, and still unanswered it is KEPT as unknown
    // (`BaseMlsService.unresolvedCommit.test.ts` owns that path).
    await expect(runCommit(ctx, 'g')).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(ctx.clearPendingCommit).not.toHaveBeenCalled();
    expect(commitRateLimitRemainingMs()).toBe(0);
  });

  it('keeps a commit whose RESUBMISSION is rate limited: the 429 says nothing of the first request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx();
    ctx.delivery.submitCommit
      .mockRejectedValueOnce(new ApiRefusalError(502, null, 'Commit submission HTTP error (502)'))
      .mockRejectedValueOnce(
        new ApiRefusalError(429, 'RATE_LIMITED', 'Commit submission HTTP error (429)', {
          retryAfterMs: 30_000,
        })
      );

    // The first request may have landed; the throttler answered the second before the gate. A
    // clear here could leave this device behind its own accepted commit.
    await expect(runCommit(ctx, 'g')).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(ctx.clearPendingCommit).not.toHaveBeenCalled();
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    expect(await ctx.recorder.pendingSubmission()).toMatchObject({
      status: 'recorded',
      record: { baseEpoch: 195 },
    });
    expect(commitRateLimitRemainingMs()).toBeGreaterThan(29_000);
  });

  it('never rebuilds on a 409 to the RESUBMISSION: our own first request may have written the seat', async () => {
    // The server's commit lock lives 5 s and the first request may wait 30 s, so it can still be
    // inside its transaction when the resubmission meets the seat it wrote. Kept, never rebuilt.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx();
    ctx.delivery.submitCommit
      .mockRejectedValueOnce(new ApiRefusalError(502, null, 'Commit submission HTTP error (502)'))
      .mockRejectedValueOnce(overtaken());
    const stageFn = vi.fn(async () => ({
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
    }));

    const err = await (
      BaseMlsService.prototype as unknown as {
        runCommitTransaction: (
          g: string,
          s: (intent: Uint8Array) => Promise<unknown>
        ) => Promise<unknown>;
      }
    ).runCommitTransaction
      .call(ctx, 'g', ctx.recorder.wrap(stageFn))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(stageFn).toHaveBeenCalledTimes(1);
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(ctx.clearPendingCommit).not.toHaveBeenCalled();
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
  });

  it('notes the group unresolved when the clear after a first-request 429 fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = makeCtx({
      clearPendingCommit: vi.fn().mockRejectedValue(new Error('locked')),
      unresolvedGroups: new Set<string>(),
    });
    ctx.delivery.submitCommit.mockRejectedValue(
      new ApiRefusalError(429, 'RATE_LIMITED', 'Commit submission HTTP error (429)')
    );

    const refused = await runCommit(ctx, 'g').catch((e: unknown) => e);

    expect((refused as CommitRefusedError).reason).toBe('rate_limited');
    expect((ctx as unknown as { unresolvedGroups: Set<string> }).unresolvedGroups.has('g')).toBe(
      true
    );
  });

  it('refuses the next commit BEFORE staging it while the wait holds - no second 429 is collected', async () => {
    const first = makeCtx();
    first.delivery.submitCommit.mockRejectedValue(
      new ApiRefusalError(429, 'RATE_LIMITED', 'Commit submission HTTP error (429)', {
        retryAfterMs: 30_000,
      })
    );
    await runCommit(first, 'g1').catch(() => undefined);

    // Another group, same account: the per-user quota is spent for it too.
    const second = makeCtx();
    const stageFn = vi.fn(async () => ({
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
    }));
    const refused = await (
      BaseMlsService.prototype as unknown as {
        runCommitTransaction: (g: string, s: typeof stageFn) => Promise<unknown>;
      }
    ).runCommitTransaction
      .call(second, 'g2', stageFn)
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(CommitRefusedError);
    expect((refused as CommitRefusedError).reason).toBe('rate_limited');
    expect(stageFn).not.toHaveBeenCalled();
    expect(second.delivery.submitCommit).not.toHaveBeenCalled();
  });
});

describe('BaseMlsService - a partial replay after a refused commit', () => {
  it('asks for a checkpoint when commits applied without closing the gap, and not when none did', async () => {
    const persistNow = vi.mocked(scheduleOutboundMlsPersist);
    persistNow.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const partial = makeCtx();
    partial.fetchCommitsSince.mockResolvedValue({
      commits: [{ baseEpoch: 195, proto: 'AA==' }],
      activeEpoch: 400,
      belowFloor: false,
    });
    await partial.catchUpOnRefusedCommit('g', 195, 400);
    expect(partial.state.epoch).toBe(196);
    expect(persistNow).toHaveBeenCalledTimes(1);

    persistNow.mockClear();
    const none = makeCtx();
    none.fetchCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 400, belowFloor: true });
    await none.catchUpOnRefusedCommit('g', 195, 400);
    expect(persistNow).not.toHaveBeenCalled();
  });
});

/**
 * A REFUSED COMMIT'S CATCH-UP HELD BEHIND A REFUSED BACKLOG ASKS FOR THE PULL THAT ENDS THE HOLD
 * (round 4 of #2414): the mark is discharged only by a pull, and a quiet conversation has no next
 * frame to start one - so the hold used to last until the stuck-gap escalation or a reconnect.
 */
describe('BaseMlsService - a refused commit held behind a refused backlog', () => {
  beforeEach(() => {
    resetUnackedFrames();
    resetEpochGapRegistry();
  });

  it('replays nothing, asks for the pull ONCE, and replays once that pull has discharged the backlog', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = makeCtx();
    ctx.fetchCommitsSince.mockResolvedValue({
      commits: [{ baseEpoch: 195, proto: 'AA==' }],
      activeEpoch: 196,
      belowFloor: false,
    });
    noteUnackedFrame('g', 'absent-conversation');

    await ctx.catchUpOnRefusedCommit('g', 195, 196);

    expect(ctx.processIncomingMessage).not.toHaveBeenCalled();
    expect(ctx.notifyConversationAvailable).toHaveBeenCalledTimes(1);
    expect(ctx.notifyConversationAvailable).toHaveBeenCalledWith('g');

    // The pull listed the whole mailbox: the backlog is discharged, and the next refusal replays.
    dischargeRefusedBacklog(refusedBacklogMark());
    await ctx.catchUpOnRefusedCommit('g', 195, 196);

    expect(ctx.state.epoch).toBe(196);
    expect(isInEpochGap('g')).toBe(false);
    expect(ctx.notifyConversationAvailable).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

/**
 * A `concurrent_commit` REPORTS THE EPOCH THE GATE READ WHILE ANOTHER COMMIT HELD ITS LOCK (CC-4,
 * 2026-10-25): "not ahead" there is not an answer, so the log is read once - a winner that landed is
 * applied, which is the progress a caller's rebuild needs; one that did not leaves the epoch, and no
 * gap is marked for a group that has none.
 */
describe('BaseMlsService - a commit refused concurrent_commit', () => {
  beforeEach(() => resetEpochGapRegistry());

  it('reads the log once and applies the winner that landed, so the epoch MOVES', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 195,
    });
    ctx.fetchCommitsSince.mockResolvedValue({
      commits: [{ baseEpoch: 195, proto: 'AQID' }],
      activeEpoch: 196,
      belowFloor: false,
    });

    await expect(runCommit(ctx, 'g')).rejects.toThrow('Staged commit rejected: concurrent_commit');

    expect(ctx.fetchCommitsSince).toHaveBeenCalledWith('g', 195);
    expect(ctx.state.epoch).toBe(196);
    expect(isInEpochGap('g')).toBe(false);
  });

  it('held behind a refused backlog: asks for its pull once, in ONE [COMMIT] line, no [GAP]', async () => {
    resetUnackedFrames();
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 195,
    });
    ctx.fetchCommitsSince.mockResolvedValue({
      commits: [{ baseEpoch: 195, proto: 'AQID' }],
      activeEpoch: 196,
      belowFloor: false,
    });
    noteUnackedFrame('g', 'absent-conversation');
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);

    await expect(runCommit(ctx, 'g')).rejects.toBeInstanceOf(CommitRefusedError);

    expect(ctx.processIncomingMessage).not.toHaveBeenCalled();
    expect(ctx.notifyConversationAvailable).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.includes('[GAP]'))).toEqual([]);
    expect(lines.filter((l) => l.includes('refused concurrent_commit at epoch 195'))).toHaveLength(
      1
    );
    vi.restoreAllMocks();
    resetUnackedFrames();
  });

  it('leaves the epoch and marks no gap when the winner has not landed yet', async () => {
    const ctx = makeCtx();
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 195,
    });
    ctx.fetchCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 195, belowFloor: false });
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);

    await expect(runCommit(ctx, 'g')).rejects.toBeInstanceOf(CommitRefusedError);

    expect(ctx.state.epoch).toBe(195);
    expect(ctx.processIncomingMessage).not.toHaveBeenCalled();
    expect(isInEpochGap('g')).toBe(false);
    // An ordinary race, so no `[GAP]` narration (the GAP rows assert none) - ONE `[COMMIT]` line.
    expect(lines.filter((l) => l.includes('[GAP]'))).toEqual([]);
    expect(lines.filter((l) => l.includes('refused concurrent_commit at epoch 195'))).toHaveLength(
      1
    );
    vi.restoreAllMocks();
  });
});
