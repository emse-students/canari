import {
  solicitHistory,
  solicitHistoryIfMissing,
  reSolicitAwaitingHistory,
  noteHistoryBundleReceived,
  cancelHistorySolicit,
  cancelAllHistorySolicit,
  isSolicitInFlight,
  startAwaitingHistorySweep,
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
  return { sendHistoryRequest: vi.fn().mockResolvedValue({ noPeerOnline: false }) };
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

    noteHistoryBundleReceived(USER, 'g1', 3);
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

    noteHistoryBundleReceived(USER, 'g1', 1);
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
  });

  it('moves straight to pending-offline when the SERVER says no member was online', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockResolvedValue({ noPeerOnline: true });

    solicitHistory(mls, 'g1', log, []);
    await vi.advanceTimersByTimeAsync(INITIAL);

    // The server elects the responder, so it has already answered the question the 30 s window
    // exists to ask - burning it would show "waiting" for a request nobody received.
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-offline');
  });

  it('keeps waiting when the request could not be answered at all', async () => {
    const mls = makeMls();
    // No answer is not a negative answer: a dropped response says nothing about who is reachable.
    mls.sendHistoryRequest.mockResolvedValue({ noPeerOnline: false });

    solicitHistory(mls, 'g1', log, []);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');
  });

  it('still retries on the backoff after a no-member answer', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockResolvedValue({ noPeerOnline: true });

    solicitHistory(mls, 'g1', log, [1000]);
    await vi.advanceTimersByTimeAsync(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    // "Nobody now" is not "nobody ever": the backoff and the presence edge must still fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
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

describe('noteHistoryBundleReceived', () => {
  const MARKER = `mls_awaiting_history_since:${USER}:g1`;

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

  it('ends a PRESUMED wait on a non-empty bundle: we no longer hold nothing', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    noteHistoryBundleReceived(USER, 'g1', 12);
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it.each([['peer-holds-more'], ['unreadable-frames']] as const)(
    'keeps a %s marker across a non-empty bundle: messages are not the proof being answered',
    (reason) => {
      markAwaitingHistory(USER, 'g1', reason);
      noteHistoryBundleReceived(USER, 'g1', 40);
      expect(localStorage.getItem(MARKER)).not.toBeNull();
    }
  );

  it.each([['no-local-history'], ['peer-holds-more'], ['unreadable-frames']] as const)(
    'an EMPTY bundle ends the wait whatever the evidence was (%s)',
    (reason) => {
      markAwaitingHistory(USER, 'g1', reason);
      noteHistoryBundleReceived(USER, 'g1', 0);
      expect(localStorage.getItem(MARKER)).toBeNull();
    }
  );

  it('keeps the in-session retries running while a proven gap is only partly answered', () => {
    markAwaitingHistory(USER, 'g1', 'peer-holds-more');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    // A chunk lands, but the ids the peer named are not thereby accounted for: ask again.
    noteHistoryBundleReceived(USER, 'g1', 200);
    vi.advanceTimersByTime(1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    // The next exchange finds nothing left to send, which is what finally ends it.
    noteHistoryBundleReceived(USER, 'g1', 0);
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it('takes the offline banner down on ANY bundle, including one that does not end the wait', () => {
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    noteHistoryBundleReceived(USER, 'g1', 5);
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(localStorage.getItem(MARKER)).not.toBeNull();
  });

  it('clears an expired proof rather than keeping it alive on a partial answer', () => {
    vi.setSystemTime(1_000_000);
    markAwaitingHistory(USER, 'g1', 'peer-holds-more');
    // Past the 30-day give-up horizon: the marker no longer proves anything.
    vi.setSystemTime(1_000_000 + 31 * 24 * 60 * 60 * 1000);
    noteHistoryBundleReceived(USER, 'g1', 7);
    expect(localStorage.getItem(MARKER)).toBeNull();
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

  it('asks again once a burst has ENDED without ever being answered', () => {
    // The case every trigger has to survive: the burst ran while no peer was online, so nothing ever
    // called `cancelHistorySolicit`. Reading the registry entry as "in flight" made the group
    // permanently skipped - a reconnect, a peer coming back and an escalation alike - until the tab
    // was reloaded, which silenced precisely the situation the retries exist for.
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    vi.advanceTimersByTime(INITIAL + 1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    // Past the last attempt plus its response window: no attempt is owed and none is awaited.
    vi.advanceTimersByTime(30_000 + 1);
    expect(isSolicitInFlight('g1')).toBe(false);

    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
  });

  it('still counts the burst as in flight while its response window is open', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    // Last attempt has fired, but a bundle answering it is still possible.
    vi.advanceTimersByTime(INITIAL + 1000 + 5_000);
    expect(isSolicitInFlight('g1')).toBe(true);
  });
});

describe('startAwaitingHistorySweep', () => {
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

  it('keeps asking on its own cadence when no event ever fires again', () => {
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();
    // The sweep runs once immediately (createPausableInterval), which is the login pass.
    const stop = startAwaitingHistorySweep({
      mlsService: mls,
      userId: USER,
      getLocalGroups: () => ['g1'],
      log,
      intervalMs: 60_000,
    });
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    // A whole interval later the burst is over, so the sweep is what asks again - no reconnect, no
    // peer edge, no escalation involved.
    vi.advanceTimersByTime(60_000 + INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
    stop();
  });

  it('asks for nothing when no group carries a marker', () => {
    const mls = makeMls();
    const stop = startAwaitingHistorySweep({
      mlsService: mls,
      userId: USER,
      getLocalGroups: () => ['g1'],
      log,
      intervalMs: 60_000,
    });
    vi.advanceTimersByTime(60_000 * 3 + INITIAL);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    stop();
  });

  it('stops for good once the session is torn down', () => {
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();
    const stop = startAwaitingHistorySweep({
      mlsService: mls,
      userId: USER,
      getLocalGroups: () => ['g1'],
      log,
      intervalMs: 60_000,
    });
    stop();
    cancelAllHistorySolicit();
    vi.advanceTimersByTime(60_000 * 3 + INITIAL);
    // Only the immediate run at registration, never a tick after the stop.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(0);
  });
});
