import {
  solicitHistory,
  reSolicitAwaitingHistory,
  noteHistoryBundleReceived,
  cancelHistorySolicit,
  cancelAllHistorySolicit,
} from './historySolicit';
import { enumerateAwaitingHistory } from './awaitingHistoryRegistry';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';

const log = () => {};
const USER = 'user-1';
// Attempt 0 is deferred by this default; tests advance past it to observe the first fire.
const INITIAL = 2500;

function makeMls() {
  return { sendHistoryRequest: vi.fn().mockResolvedValue(undefined) };
}

describe('solicitHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    historyRequestPendingStore.cancelAll();
  });
  afterEach(() => {
    cancelAllHistorySolicit();
    historyRequestPendingStore.cancelAll();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('defers the first request past the initial delay, then re-solicits on the backoff', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000, 2000]);

    // Attempt 0 is deferred, not synchronous (lets a self-join peer apply our commit first).
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');

    vi.advanceTimersByTime(1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);

    // No further retries beyond the provided delays.
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
  });

  it('marks the group awaiting-history durably until a bundle is received', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000]);
    expect(enumerateAwaitingHistory(USER)).toEqual(['g1']);

    noteHistoryBundleReceived(USER, 'g1');
    expect(enumerateAwaitingHistory(USER)).toEqual([]);
  });

  it('stops retrying once a history_bundle is received', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000, 2000]);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    noteHistoryBundleReceived(USER, 'g1');
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('cancelHistorySolicit only affects the named group', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000]);
    solicitHistory(mls, USER, 'g2', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    cancelHistorySolicit('g1');
    vi.advanceTimersByTime(1000);
    // Only g2's retry fires.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
    expect(mls.sendHistoryRequest).toHaveBeenLastCalledWith('g2');
  });

  it('re-soliciting the same group restarts cleanly without duplicating timers', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000]);
    solicitHistory(mls, USER, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    // The first call's timers were cancelled by the second: a single attempt-0 fires.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    // Only the surviving (second) solicitation's single retry fires.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
  });
  it('moves the reactive pending state to pending-offline when the response window elapses', () => {
    const mls = makeMls();
    // No burst delays: we only want to observe the single request window.
    solicitHistory(mls, USER, 'g1', log, []);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    // WP-HIST-1 response timeout is 30 s from the moment the request fires.
    vi.advanceTimersByTime(30_000);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
  });

  it('clears the reactive pending state when the bundle arrives', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    noteHistoryBundleReceived(USER, 'g1');
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
  });

  it('moves straight to pending-offline when the network is offline', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('navigator', { onLine: false });

    solicitHistory(mls, USER, 'g1', log, []);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
    vi.unstubAllGlobals();
  });
});

describe('reSolicitAwaitingHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    historyRequestPendingStore.cancelAll();
  });
  afterEach(() => {
    cancelAllHistorySolicit();
    historyRequestPendingStore.cancelAll();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('re-solicits an awaiting group that is held locally, across a session boundary', () => {
    // Simulate a prior session that solicited but never received the bundle.
    const first = makeMls();
    solicitHistory(first, USER, 'g1', log, [1000]);
    cancelAllHistorySolicit(); // session ends: in-memory timers gone, durable marker remains.
    expect(enumerateAwaitingHistory(USER)).toEqual(['g1']);

    // New session: re-solicit drives a fresh burst for the still-awaiting local group.
    const mls = makeMls();
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');
  });

  it('skips groups that are not held locally (recovery re-joins them instead)', () => {
    const first = makeMls();
    solicitHistory(first, USER, 'g1', log, [1000]);
    cancelAllHistorySolicit();

    const mls = makeMls();
    reSolicitAwaitingHistory(mls, USER, [], log); // g1 not local
    vi.advanceTimersByTime(INITIAL + 10_000);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('does not restart a solicitation that is still in flight', () => {
    const mls = makeMls();
    solicitHistory(mls, USER, 'g1', log, [1000]);
    // Still in flight (attempt 0 not yet fired): re-solicit must be a no-op for g1.
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });
});
