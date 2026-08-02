import {
  solicitHistory,
  solicitHistoryIfMissing,
  reSolicitAwaitingHistory,
  noteHistoryBundleReceived,
  cancelHistorySolicit,
  cancelAllHistorySolicit,
} from './historySolicit';
import { enumerateAwaitingHistory, markAwaitingHistory } from './awaitingHistoryRegistry';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
import type { IStorage } from '$lib/db';

const log = () => {};
const USER = 'user-1';
const KEY = 'device-key';
// Attempt 0 is deferred by this default; tests advance past it to observe the first fire.
const INITIAL = 2500;

function makeMls() {
  return { sendHistoryRequest: vi.fn().mockResolvedValue(undefined) };
}

/** Minimal storage double: only `getMessages` is consulted by the decision seam. */
function makeStorage(messages: unknown[]): IStorage {
  return { getMessages: vi.fn().mockResolvedValue(messages) } as unknown as IStorage;
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
    solicitHistory(mls, 'g1', log, [1000, 2000]);

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

  it('does NOT record the group as awaiting: asking is not evidence of a gap', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    expect(enumerateAwaitingHistory(USER)).toEqual([]);
  });

  it('stops retrying once a history_bundle is received', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000, 2000]);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    noteHistoryBundleReceived(USER, 'g1');
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('cancelHistorySolicit only affects the named group', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    solicitHistory(mls, 'g2', log, [1000]);
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
    solicitHistory(mls, 'g1', log, [1000]);
    solicitHistory(mls, 'g1', log, [1000]);
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
    solicitHistory(mls, 'g1', log, []);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    // WP-HIST-1 response timeout is 30 s from the moment the request fires.
    vi.advanceTimersByTime(30_000);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
  });

  it('clears the reactive pending state when the bundle arrives', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    noteHistoryBundleReceived(USER, 'g1');
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
  });

  it('moves straight to pending-offline when the network is offline', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('navigator', { onLine: false });

    solicitHistory(mls, 'g1', log, []);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
    vi.unstubAllGlobals();
  });
});

describe('solicitHistoryIfMissing', () => {
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

  it('solicits and marks awaiting when the local store holds nothing for the group', async () => {
    const mls = makeMls();
    await solicitHistoryIfMissing({
      mlsService: mls,
      storage: makeStorage([]),
      userId: USER,
      deviceKeyB64: KEY,
      groupId: 'g1',
      log,
    });

    expect(enumerateAwaitingHistory(USER)).toEqual(['g1']);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');
  });

  it('stays silent when the store already holds the conversation (identity rotation)', async () => {
    const mls = makeMls();
    await solicitHistoryIfMissing({
      mlsService: mls,
      storage: makeStorage([{ id: 'm1' }]),
      userId: USER,
      deviceKeyB64: KEY,
      groupId: 'g1',
      log,
    });

    expect(enumerateAwaitingHistory(USER)).toEqual([]);
    vi.advanceTimersByTime(INITIAL + 10_000);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('drops a marker left by the old join-time behaviour when nothing is missing', async () => {
    localStorage.setItem(`mls_awaiting_history_since:${USER}:g1`, String(Date.now()));

    await solicitHistoryIfMissing({
      mlsService: makeMls(),
      storage: makeStorage([{ id: 'm1' }]),
      userId: USER,
      deviceKeyB64: KEY,
      groupId: 'g1',
      log,
    });

    expect(localStorage.getItem(`mls_awaiting_history_since:${USER}:g1`)).toBeNull();
  });

  it('still solicits a PROVEN gap even though the store is full', async () => {
    // The replay gave up on a frame of g1: a full store does not make it readable.
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();

    await solicitHistoryIfMissing({
      mlsService: mls,
      storage: makeStorage([{ id: 'm1' }]),
      userId: USER,
      deviceKeyB64: KEY,
      groupId: 'g1',
      log,
    });

    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');
    expect(enumerateAwaitingHistory(USER)).toEqual(['g1']);
  });

  it('solicits when the store read fails: a failed read proves nothing', async () => {
    const mls = makeMls();
    const storage = {
      getMessages: vi.fn().mockRejectedValue(new Error('db closed')),
    } as unknown as IStorage;

    await solicitHistoryIfMissing({
      mlsService: mls,
      storage,
      userId: USER,
      deviceKeyB64: KEY,
      groupId: 'g1',
      log,
    });

    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');
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
    // A prior session recorded the gap but never received the bundle.
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    expect(enumerateAwaitingHistory(USER)).toEqual(['g1']);

    const mls = makeMls();
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');
  });

  it('skips groups that are not held locally (recovery re-joins them instead)', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');

    const mls = makeMls();
    reSolicitAwaitingHistory(mls, USER, [], log); // g1 not local
    vi.advanceTimersByTime(INITIAL + 10_000);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('ignores a legacy marker carrying no evidence, and prunes it', () => {
    localStorage.setItem(`mls_awaiting_history_since:${USER}:g1`, String(Date.now()));

    const mls = makeMls();
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL + 10_000);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(localStorage.getItem(`mls_awaiting_history_since:${USER}:g1`)).toBeNull();
  });

  it('does not restart a solicitation that is still in flight', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    // Still in flight (attempt 0 not yet fired): re-solicit must be a no-op for g1.
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });
});
