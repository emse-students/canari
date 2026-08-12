import {
  solicitHistory,
  solicitHistoryIfMissing,
  reSolicitAwaitingHistory,
  noteHistoryBundleReceived,
  cancelHistorySolicit,
  cancelAllHistorySolicit,
  isSolicitInFlight,
  startAwaitingHistorySweep,
  setHistoryDigestBroadcaster,
} from './historySolicit';
import { enumerateAwaitingHistory, markAwaitingHistory } from './awaitingHistoryRegistry';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
import type { IStorage } from '$lib/db';

const log = () => {};
const USER = 'user-1';
const KEY = 'device-key';
// The request is deferred by this default; tests advance past it to observe it go out.
const INITIAL = 2500;
/** The tracker's response window - the one duration the mechanism cannot do without. */
const RESPONSE_WINDOW = 30_000;

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

  it('sends exactly ONE request, after the ordering delay, and never repeats it', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);

    // Deferred, not synchronous: it lets a self-join peer apply our commit first, so the bundle it
    // returns is encrypted at an epoch we can read. That is an ordering constraint, not a backoff.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });

    // The property the whole rewrite exists for: one call produces one request, for good. There
    // were two independent backoff ladders here, so a single detection kept generating traffic for
    // minutes - and their schedules multiplied, which no one file could be read to predict.
    vi.advanceTimersByTime(60 * 60_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('does NOT record the group as awaiting: asking is not evidence of a gap', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    expect(enumerateAwaitingHistory(USER)).toEqual([]);
  });

  it('ignores a second call while an attempt is outstanding', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);

    // Idempotent by state, not by a rate limit: what suppresses the second ask is that the first is
    // still outstanding, so nothing has to be tuned and nothing decays.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    // Still outstanding (the window is open), so a third call is a no-op too.
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('becomes askable again the moment the window closes - no cooldown of its own', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(isSolicitInFlight('g1')).toBe(true);

    vi.advanceTimersByTime(RESPONSE_WINDOW);
    expect(isSolicitInFlight('g1')).toBe(false);

    // Whether it IS asked again is the durable marker's business, reached through an edge - this
    // module only stops asking twice at once.
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
  });

  describe('the digest is conditional on a responder having been elected', () => {
    afterEach(() => setHistoryDigestBroadcaster(null));

    it('asks FIRST and broadcasts the digest only once a peer was elected', async () => {
      const order: string[] = [];
      const mls = {
        sendHistoryRequest: vi.fn().mockImplementation(async () => {
          order.push('ask');
          return { noPeerOnline: false };
        }),
      };
      setHistoryDigestBroadcaster(async () => {
        order.push('digest');
        return true;
      });

      solicitHistory(mls, 'g1', log);
      await vi.advanceTimersByTimeAsync(INITIAL);

      // The order is the fix: a digest sent first is an MLS frame every member of the group
      // decrypts, for a repair the server may be about to refuse outright.
      expect(order).toEqual(['ask', 'digest']);
      expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: true });
    });

    it('sends NO digest at all when the server says nobody was online', async () => {
      const mls = {
        sendHistoryRequest: vi.fn().mockResolvedValue({ noPeerOnline: true }),
      };
      const broadcast = vi.fn().mockResolvedValue(true);
      setHistoryDigestBroadcaster(broadcast);

      solicitHistory(mls, 'g1', log);
      await vi.advanceTimersByTimeAsync(INITIAL);

      expect(broadcast).not.toHaveBeenCalled();
      expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unsent');
    });

    it('tells the responder NOT to wait when this device cannot describe itself', async () => {
      // No broadcaster registered: promising a digest would make the elected peer wait out its
      // whole bound for a frame that is never coming.
      const mls = makeMls();
      solicitHistory(mls, 'g1', log);
      await vi.advanceTimersByTimeAsync(INITIAL);

      expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });
    });
  });

  it('cancelHistorySolicit only affects the named group', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    solicitHistory(mls, 'g2', log);

    cancelHistorySolicit('g1');
    vi.advanceTimersByTime(INITIAL);

    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g2', { withDigest: false });
  });

  it('moves the reactive pending state to pending-unanswered when the window elapses', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    vi.advanceTimersByTime(RESPONSE_WINDOW);
    // Unanswered, NOT unsent: the request went out and a peer may well have been online. The UI
    // reads this phase directly, so collapsing the two is a wrong statement to a user.
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unanswered');
  });

  it('clears the reactive pending state when the bundle arrives', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);

    noteHistoryBundleReceived(USER, 'g1', 1);
    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
  });

  it('moves straight to pending-unsent when the SERVER says no member was online', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockResolvedValue({ noPeerOnline: true });

    solicitHistory(mls, 'g1', log);
    await vi.advanceTimersByTimeAsync(INITIAL);

    // The server elects the responder, so it has already answered the question the window exists to
    // ask - burning it would show "waiting" for a request nobody received.
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unsent');
  });

  it('keeps waiting when the request went out and simply has not been answered', async () => {
    const mls = makeMls();
    // No answer is not a negative answer: a dropped response says nothing about who is reachable.
    solicitHistory(mls, 'g1', log);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');
  });

  it('moves straight to pending-unreachable when the send throws while offline', async () => {
    const mls = makeMls();
    mls.sendHistoryRequest.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('navigator', { onLine: false });

    solicitHistory(mls, 'g1', log);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unreachable');
    vi.unstubAllGlobals();
  });

  it('moves to pending-unreachable when the send throws and navigator says we are ONLINE', async () => {
    // THE PRODUCTION CASE, seen by a user during a thirty-second deploy: the server answers 502, so
    // the send throws, but `navigator.onLine` is perfectly true because the network is fine. The
    // old code took that branch to mean "not a network failure", logged, and left the response
    // window open - and thirty seconds later the timer reported `pending-unanswered`, telling the
    // user no device had answered a request no device had ever been sent.
    const mls = makeMls();
    mls.sendHistoryRequest.mockRejectedValue(new Error('502 Bad Gateway'));
    vi.stubGlobal('navigator', { onLine: true });

    solicitHistory(mls, 'g1', log);
    await vi.advanceTimersByTimeAsync(INITIAL);

    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unreachable');

    // And it must STAY that way: the window is closed, so the 30 s timer can no longer speak.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending-unreachable');
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
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });
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
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });
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
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });
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

  it('an empty UNVOUCHED bundle discharges peer-holds-more - its evidence is falsified', () => {
    // The marker was written because that peer listed ids we lacked. An empty symmetric diff with
    // the same peer says it no longer holds anything we do not, so the evidence is gone. Whether
    // the peer is itself awaiting is irrelevant to that claim - it is about OUR store, not its.
    markAwaitingHistory(USER, 'g1', 'peer-holds-more');
    noteHistoryBundleReceived(USER, 'g1', 0, { vouched: false });
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it.each([['unreadable-frames'], ['no-local-history']] as const)(
    'an empty UNVOUCHED bundle does NOT discharge %s - only a third device can answer it',
    (reason) => {
      // A frame BOTH devices lack is still lost. Sweeping this up with the case above would
      // convert "nobody here has it" into "you are complete" and stop the group ever asking the
      // one device that might still hold it.
      markAwaitingHistory(USER, 'g1', reason);
      noteHistoryBundleReceived(USER, 'g1', 0, { vouched: false });
      expect(localStorage.getItem(MARKER)).not.toBeNull();
    }
  );

  it('an empty UNVOUCHED bundle still ends the ATTEMPT, which is what unsticks the banner', () => {
    // The deadlock's visible symptom: two peers both awaiting answered each other with silence, so
    // every attempt died on the 30 s window and the banner never came down again (WP-HISTBANNER-1).
    // The marker legitimately survives here - the banner must not.
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(historyRequestPendingStore.getPhase('g1')).toBe('pending');

    noteHistoryBundleReceived(USER, 'g1', 0, { vouched: false });

    expect(historyRequestPendingStore.getPhase('g1')).toBeNull();
    expect(localStorage.getItem(MARKER)).not.toBeNull();
  });

  it('keeps a proven marker alive through a partial answer, and lets an empty diff end it', () => {
    // This is what makes the mechanism terminate without counting anything. A chunk of messages is
    // not an answer to "you are missing these ids", so the marker survives and the next edge asks
    // again; each exchange strictly reduces the difference, so it converges on the empty diff below
    // rather than on a retry budget.
    markAwaitingHistory(USER, 'g1', 'peer-holds-more');

    noteHistoryBundleReceived(USER, 'g1', 200);
    expect(localStorage.getItem(MARKER)).not.toBeNull();

    noteHistoryBundleReceived(USER, 'g1', 0);
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it('takes the offline banner down on ANY bundle, including one that does not end the wait', () => {
    markAwaitingHistory(USER, 'g1', 'unreadable-frames');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
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
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1', { withDigest: false });
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

  it('does not duplicate an attempt that is still outstanding', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    // Decided but not yet sent - already outstanding, so this edge must add nothing.
    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('asks again once an attempt has ENDED without ever being answered', () => {
    // The case every trigger has to survive: nobody answered, so nothing ever called
    // `cancelHistorySolicit`. The old code derived "in flight" from a `burstEndsAt` arithmetic and
    // left the entry behind, so the group was permanently skipped by every later trigger - a
    // reconnect, a peer coming back, a new detection alike - until the tab was reloaded. Being
    // outstanding is now a STATE that an event ends, so this cannot recur.
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RESPONSE_WINDOW);
    expect(isSolicitInFlight('g1')).toBe(false);

    reSolicitAwaitingHistory(mls, USER, ['g1'], log);
    vi.advanceTimersByTime(INITIAL);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
  });

  it('counts an attempt as outstanding while its response window is open', () => {
    markAwaitingHistory(USER, 'g1', 'no-local-history');
    const mls = makeMls();
    solicitHistory(mls, 'g1', log);
    // The request has gone out, and a bundle answering it is still possible.
    vi.advanceTimersByTime(INITIAL + 5_000);
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
