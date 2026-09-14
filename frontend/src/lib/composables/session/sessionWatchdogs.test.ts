import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

/**
 * What the SYNC_WATCHDOG tick decides FOR ITSELF, and nothing else.
 *
 * The recovery seam, the not-ready registry and `makeRecoveryDeps` are mocked, deliberately: each
 * is exercised by its own suite, and re-asserting them here would only assert the mocks. What is
 * left is exactly what this file owns and what changed - WHEN the tick crosses into WASM, WHEN it
 * asks the seam for a re-add, and which of the two nets keeps the fine cadence alive.
 */
const getIsTabLeader = vi.fn(() => true);
const getLocalGroups = vi.fn<() => string[]>(() => []);
const requestReAdd = vi.fn(async () => {});
const recoverForkedGroup = vi.fn(async () => {});
const cancelReAdd = vi.fn();
const isReAddDue = vi.fn((_id: string) => true);
const clearGroupNotReady = vi.fn();
const enumerateNotReadyGroups = vi.fn<() => string[]>(() => []);
/** A real registry, small enough to keep honest: a cleared gap must actually stop being armed. */
const gaps = new Map<string, number>();
const isDistributionGroup = vi.fn((_id: string) => false);
const externalJoin = vi.fn(async (_id: string) => ({ joined: true }) as Record<string, unknown>);
const persistCheckpoint = vi.fn(async () => {});
const dropGroupState = vi.fn(async () => {});

vi.mock('$lib/utils/chat/connection', () => ({ getIsTabLeader: () => getIsTabLeader() }));
vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: (...a: unknown[]) => requestReAdd(...(a as [])),
  recoverForkedGroup: (...a: unknown[]) => recoverForkedGroup(...(a as [])),
  cancelReAdd: (...a: unknown[]) => cancelReAdd(...(a as [])),
  isReAddDue: (id: string) => isReAddDue(id),
}));
vi.mock('$lib/utils/chat/notReadyRegistry', () => ({
  clearGroupNotReady: (...a: unknown[]) => clearGroupNotReady(...(a as [])),
  enumerateNotReadyGroups: () => enumerateNotReadyGroups(),
}));
vi.mock('$lib/utils/chat/epochGapRegistry', () => ({
  clearEpochGap: (id: string) => void gaps.delete(id),
  anyEpochGapArmed: () => gaps.size > 0,
  stuckEpochGaps: (olderThanMs: number, now: number) =>
    [...gaps.entries()]
      .filter(([, since]) => now - since > olderThanMs)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id),
}));
vi.mock('$lib/utils/chat/dropGroupState', () => ({
  dropGroupState: (...a: unknown[]) => dropGroupState(...(a as [])),
}));
vi.mock('./sessionAuth', () => ({
  makeRecoveryDeps: () => ({
    userId: 'u1',
    mlsService: { getLocalGroups, isDistributionGroup, externalJoin, persistCheckpoint },
  }),
}));

const { startSyncWatchdogImpl } = await import('./sessionWatchdogs');

const TICK_MS = 5_000;
const SWEEP_MS = 5 * 60_000;

/** The two objects the tick actually reads, reduced to the fields it reads. */
function harness(conversations: { id: string }[] = []) {
  const ctx = { timers: { syncWatchdog: null } };
  const cb = { conversations: new SvelteMap(conversations.map((c) => [c.id, c])), log: vi.fn() };
  return { ctx, cb } as never as {
    ctx: Parameters<typeof startSyncWatchdogImpl>[0];
    cb: Parameters<typeof startSyncWatchdogImpl>[1];
  };
}

describe('startSyncWatchdogImpl - what a quiet tab costs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getIsTabLeader.mockReturnValue(true);
    getLocalGroups.mockReturnValue([]);
    isReAddDue.mockReturnValue(true);
    gaps.clear();
    isDistributionGroup.mockReturnValue(false);
    externalJoin.mockResolvedValue({ joined: true });
    enumerateNotReadyGroups.mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps on the first tick, so a session resuming with a stuck group does not wait five minutes', () => {
    const { ctx, cb } = harness([{ id: 'g1' }]);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);

    expect(requestReAdd).toHaveBeenCalledTimes(1);
    expect(getLocalGroups).toHaveBeenCalledTimes(1);
  });

  it('does not ask again until the sweep is due, where it used to ask twelve times a minute', () => {
    const { ctx, cb } = harness([{ id: 'g1' }]);
    startSyncWatchdogImpl(ctx, cb);

    // The first tick sweeps and arms the clock; the next sweep is a full window after THAT tick.
    vi.advanceTimersByTime(SWEEP_MS + TICK_MS);

    // 61 ticks, two sweeps. The old shape asked once per tick.
    expect(requestReAdd).toHaveBeenCalledTimes(2);
  });

  it('never crosses into WASM on a tick that could not act', () => {
    // The measured cost of the old shape: `get_groups()` every five seconds for a whole session,
    // to decide nothing. Nothing is armed and no sweep is owed, so the tick must return first.
    const { ctx, cb } = harness([{ id: 'g1' }]);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS * 12);

    expect(getLocalGroups).toHaveBeenCalledTimes(1);
  });

  it('keeps the fine tick for the stuck-gap net, which is the only net that needs it', () => {
    // A 45 s threshold cannot be served by a five-minute sweep, so an armed gap must pull the tick
    // through every five seconds even while no recovery is owed.
    const { ctx, cb } = harness([{ id: 'g1' }]);
    getLocalGroups.mockReturnValue(['g1']);
    gaps.set('g1', Date.now() - 10_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS * 3);

    expect(getLocalGroups).toHaveBeenCalledTimes(3);
    expect(recoverForkedGroup).not.toHaveBeenCalled();
  });

  it('escalates a stuck gap once, then goes quiet again', () => {
    const { ctx, cb } = harness([{ id: 'g1' }]);
    getLocalGroups.mockReturnValue(['g1']);
    gaps.set('g1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS * 3);

    expect(recoverForkedGroup).toHaveBeenCalledTimes(1);
    expect(gaps.has('g1')).toBe(false);
    // Nothing is armed any more and no sweep is owed, so the two later ticks cost nothing.
    expect(getLocalGroups).toHaveBeenCalledTimes(1);
  });

  it('reaches a stuck group that is in NO conversation - the defect this net had', async () => {
    // THE REGISTRY IS THE SET THAT NEEDS THE NET, and the candidate loop is built for another
    // question entirely. A Graine distribution group is in no conversation and in no not-ready
    // registry, so deciding this inside that loop meant a refused commit put it in the gap registry
    // and nothing ever took it out - no exit at all, short of a reload.
    const { ctx, cb } = harness([]);
    getLocalGroups.mockReturnValue(['dg1']);
    isDistributionGroup.mockReturnValue(true);
    gaps.set('dg1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);
    await vi.waitFor(() => expect(externalJoin).toHaveBeenCalledWith('dg1'));

    expect(gaps.has('dg1')).toBe(false);
  });

  it('never hands a distribution group the conversation ladder, which would purge it', async () => {
    // `requestReAdd` asks `getGroupMeta`, a distribution group has no `dm_groups` row, and the
    // answer CONFIRMED ABSENT purges it as a phantom - a community losing every seed it holds on
    // the strength of a question that was never about it.
    const { ctx, cb } = harness([]);
    getLocalGroups.mockReturnValue(['dg1']);
    isDistributionGroup.mockReturnValue(true);
    gaps.set('dg1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);
    await vi.waitFor(() => expect(dropGroupState).toHaveBeenCalledTimes(1));

    expect(recoverForkedGroup).not.toHaveBeenCalled();
    expect(requestReAdd).not.toHaveBeenCalled();
  });

  it('checkpoints a re-joined distribution group, so the next load does not restore the frozen tree', async () => {
    const { ctx, cb } = harness([]);
    getLocalGroups.mockReturnValue(['dg1']);
    isDistributionGroup.mockReturnValue(true);
    gaps.set('dg1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);
    await vi.waitFor(() => expect(persistCheckpoint).toHaveBeenCalledTimes(1));
  });

  it('names the reason a re-join no device of ours can repair', async () => {
    externalJoin.mockResolvedValue({
      joined: false,
      reason: 'stale_base',
      baseEpoch: 4,
      serverEpoch: 9,
    });
    const { ctx, cb } = harness([]);
    getLocalGroups.mockReturnValue(['dg1']);
    isDistributionGroup.mockReturnValue(true);
    gaps.set('dg1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);

    await vi.waitFor(() => {
      const said = cb.log.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(said).toContain('stale_base');
      expect(said).toContain('epoch 4');
    });
    expect(persistCheckpoint).not.toHaveBeenCalled();
  });

  it('clears the mark before the ladder runs, so a throwing escalation cannot re-fire every tick', async () => {
    externalJoin.mockRejectedValue(new Error('offline'));
    const { ctx, cb } = harness([]);
    getLocalGroups.mockReturnValue(['dg1']);
    isDistributionGroup.mockReturnValue(true);
    gaps.set('dg1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS * 4);
    await vi.waitFor(() => expect(externalJoin).toHaveBeenCalledTimes(1));
    expect(gaps.has('dg1')).toBe(false);
  });

  it('leaves a marked group this device holds nothing for to the candidate loop', () => {
    // A gap is a claim about HELD state lagging. A device holding nothing has no epoch to be
    // behind, and `requestReAdd` is what owns its recovery.
    const { ctx, cb } = harness([{ id: 'g1' }]);
    getLocalGroups.mockReturnValue([]);
    gaps.set('g1', Date.now() - 46_000);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(TICK_MS);

    expect(recoverForkedGroup).not.toHaveBeenCalled();
    expect(externalJoin).not.toHaveBeenCalled();
    expect(requestReAdd).toHaveBeenCalledTimes(1);
  });

  it('declines to ask a question the seam has already answered', () => {
    // The cooldown is the seam's, and a caller that DRIVES a cadence reads it instead of learning
    // it by failing. A reactive caller must keep asking - that is asserted in `recovery.test.ts`.
    const { ctx, cb } = harness([{ id: 'g1' }]);
    isReAddDue.mockReturnValue(false);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(SWEEP_MS + TICK_MS);

    expect(isReAddDue).toHaveBeenCalledWith('g1');
    expect(requestReAdd).not.toHaveBeenCalled();
  });

  it('does nothing at all when this tab is not the leader', () => {
    const { ctx, cb } = harness([{ id: 'g1' }]);
    getIsTabLeader.mockReturnValue(false);
    startSyncWatchdogImpl(ctx, cb);

    vi.advanceTimersByTime(SWEEP_MS + TICK_MS);

    expect(getLocalGroups).not.toHaveBeenCalled();
    expect(requestReAdd).not.toHaveBeenCalled();
  });
});
