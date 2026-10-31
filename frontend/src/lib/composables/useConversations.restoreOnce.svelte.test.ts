/**
 * A burst of restore asks costs at most two restores, and every asker is answered by a restore that
 * started after its ask.
 *
 * Every Welcome for a group the map lacks asks for a whole restore (`sessionAuth`'s
 * `onWelcomeProcessed`), so a new device joining 80 groups in one drain used to restore 80 times,
 * overlapping on the one WASM client. The asks are ordered by the calls alone - each restore here is
 * a deferred the test settles by hand, so no timer and no clock decides anything.
 */
import { SvelteMap } from 'svelte/reactivity';

const loadExistingConversations = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/conversations')>();
  return { ...actual, loadExistingConversations };
});

// The archive read each owed replay makes: counted, and the place a test drops the link mid-replay.
const withMlsBulkIngest = vi.hoisted(() =>
  vi.fn(async (_mls: unknown, run: () => unknown) => run())
);
vi.mock('$lib/mls-client/mlsBulkIngest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mls-client/mlsBulkIngest')>();
  return { ...actual, withMlsBulkIngest };
});
vi.mock('$lib/utils/chat/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/history')>();
  return { ...actual, replayConversationHistory: vi.fn(async () => undefined) };
});

// Same isolation reasoning as the other composable tests: `useConversations` is reachable from the
// global chat singleton's own module-scope instantiation, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');
const { reportRejectionOnce } = await import('$lib/utils/reportRejectionOnce');
const { connectivity } = await import('$lib/stores/connectivity.svelte');

function makeCtx(userId = 'u1') {
  const mls = {
    getLocalGroups: () => [],
    getDeviceId: () => 'dev-1',
    notifyConversationsRestored: vi.fn(),
    setOwedInvitationReplanner: vi.fn(),
    notifyConversationRowsSeeded: vi.fn(),
  };
  return {
    storage: { saveConversation: vi.fn(async () => undefined) },
    ensureMls: () => mls,
    userId,
    deviceKeyB64: 'k',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

/** Each restore blocks on its own deferred, released by the test in the order it chooses. */
function holdEachRestore() {
  const releases: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  loadExistingConversations.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        releases.push({ resolve, reject });
      })
  );
  return releases;
}

/** Lets every pending continuation run, so a queued restore that is going to start has started. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadAndRestoreConversations - one restore at a time, at most one queued', () => {
  it('folds a burst of asks made during a restore into ONE restore after it', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();

    const first = convs.loadAndRestoreConversations(makeCtx());
    await settle();
    expect(loadExistingConversations).toHaveBeenCalledTimes(1);

    // Eighty Welcomes land while the first restore runs.
    const contexts = Array.from({ length: 80 }, () => makeCtx());
    const burst = contexts.map((ctx) => convs.loadAndRestoreConversations(ctx));
    await settle();
    // None of them may join the running restore: it read the store before their rows were saved.
    expect(loadExistingConversations).toHaveBeenCalledTimes(1);

    releases[0].resolve();
    await first;
    await settle();
    // ONE more restore, started after every ask of the burst.
    expect(loadExistingConversations).toHaveBeenCalledTimes(2);
    // One line for the whole burst, written through the latest context.
    const lastLog = (contexts[79] as unknown as { log: ReturnType<typeof vi.fn> }).log;
    expect(lastLog).toHaveBeenCalledWith(
      '[RESTORE] one restore for 80 ask(s) made while the previous one ran'
    );
    const firstLog = (contexts[0] as unknown as { log: ReturnType<typeof vi.fn> }).log;
    expect(firstLog).not.toHaveBeenCalled();

    releases[1].resolve();
    await Promise.all(burst);
    expect(loadExistingConversations).toHaveBeenCalledTimes(2);
  });

  it('runs the queued restore with the latest context asked', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();

    const first = convs.loadAndRestoreConversations(makeCtx('u1'));
    await settle();
    const second = convs.loadAndRestoreConversations(makeCtx('u2'));
    const third = convs.loadAndRestoreConversations(makeCtx('u3'));

    releases[0].resolve();
    await first;
    await settle();
    expect(loadExistingConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'u3' })
    );
    releases[1].resolve();
    await Promise.all([second, third]);
  });

  it('runs the queued restore after a failed one, and hands each failure to its own callers', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();

    const first = convs.loadAndRestoreConversations(makeCtx());
    await settle();
    const queued = convs.loadAndRestoreConversations(makeCtx());

    releases[0].reject(new Error('IndexedDB unavailable'));
    await expect(first).rejects.toThrow('IndexedDB unavailable');
    await settle();
    expect(loadExistingConversations).toHaveBeenCalledTimes(2);

    releases[1].resolve();
    await expect(queued).resolves.toBeUndefined();
    expect(convs.conversationsRestored).toBe(true);
  });

  it('never runs a restore the signed-out session queued, and its callers resolve', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();
    const ctxA = makeCtx('alice');

    const first = convs.loadAndRestoreConversations(ctxA);
    await settle();
    const queued = convs.loadAndRestoreConversations(makeCtx('alice'));

    // Alice signs out while her first restore runs and a second one waits behind it.
    convs.invalidateRestores();
    releases[0].resolve();
    await first;
    await expect(queued).resolves.toBeUndefined();
    await settle();

    // The queued restore would have run as Alice, on a map the teardown just cleared.
    expect(loadExistingConversations).toHaveBeenCalledTimes(1);
    // Nor did the retired pass wake Alice's client, or mark the next session's map restored.
    const mls = (
      ctxA as unknown as { ensureMls: () => { notifyConversationsRestored: unknown } }
    ).ensureMls().notifyConversationsRestored;
    expect(mls).not.toHaveBeenCalled();
    expect(convs.conversationsRestored).toBe(false);
  });

  it('a sign-out un-marks the map restored, so the next session is not read as loaded', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();
    const first = convs.loadAndRestoreConversations(makeCtx('alice'));
    await settle();
    releases[0].resolve();
    await first;
    expect(convs.conversationsRestored).toBe(true);

    convs.invalidateRestores();
    expect(convs.conversationsRestored).toBe(false);
    expect(convs.conversationSourcesSettled).toBe(false);
  });

  it('a restore still running from a signed-out session never blocks the next one', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();

    // Alice's restore never settles.
    void convs.loadAndRestoreConversations(makeCtx('alice'));
    await settle();
    convs.invalidateRestores();

    // Bob signs in on the same tab: his restore starts at once, on its own chain.
    const bob = convs.loadAndRestoreConversations(makeCtx('bob'));
    await settle();
    expect(loadExistingConversations).toHaveBeenCalledTimes(2);
    expect(loadExistingConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'bob' })
    );
    releases[1].resolve();
    await expect(bob).resolves.toBeUndefined();
    expect(convs.conversationsRestored).toBe(true);
  });

  it('hands the queued failure to every folded caller, and it is reported once', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();

    const first = convs.loadAndRestoreConversations(makeCtx());
    await settle();
    const folded = Array.from({ length: 5 }, () => convs.loadAndRestoreConversations(makeCtx()));
    // Each Welcome caller reports through the same helper `sessionAuth` uses.
    const report = vi.fn();
    const reports = folded.map((p) => reportRejectionOnce(p, report));

    releases[0].resolve();
    await first;
    await settle();
    releases[1].reject(new Error('IndexedDB unavailable'));
    for (const p of folded) await expect(p).rejects.toThrow('IndexedDB unavailable');
    await Promise.all(reports);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('registers the lost-invitation re-planner only after a SUCCESSFUL restore', async () => {
    const releases = holdEachRestore();
    const convs = useConversations();
    const ctx = makeCtx();
    const mls = (
      ctx as unknown as {
        ensureMls: () => { setOwedInvitationReplanner: ReturnType<typeof vi.fn> };
      }
    ).ensureMls();

    // A failed restore leaves the map empty: every entry would read as a conversation that does not
    // exist, so nothing re-plans - the entries stay on disk.
    const failed = convs.loadAndRestoreConversations(ctx);
    await settle();
    releases[0].reject(new Error('IndexedDB unavailable'));
    await expect(failed).rejects.toThrow('IndexedDB unavailable');
    expect(mls.setOwedInvitationReplanner).not.toHaveBeenCalled();

    const ok = convs.loadAndRestoreConversations(ctx);
    await settle();
    releases[1].resolve();
    await ok;
    expect(mls.setOwedInvitationReplanner).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.any(Function)
    );

    // The sign-out removes it: the next account must not re-plan into this session's map.
    convs.invalidateRestores();
    expect(mls.setOwedInvitationReplanner).toHaveBeenLastCalledWith(null);
  });

  it('starts at once when nothing runs, each time', async () => {
    loadExistingConversations.mockResolvedValue(undefined);
    const convs = useConversations();
    await convs.loadAndRestoreConversations(makeCtx());
    await convs.loadAndRestoreConversations(makeCtx());
    expect(loadExistingConversations).toHaveBeenCalledTimes(2);
  });
});

/**
 * THE ARCHIVES A RESTORE SKIPPED ON A LINK KNOWN DOWN ARE REPLAYED ON THE NEXT RECONNECT, ONCE.
 * The restore runs at boot and on a Welcome only; without this a skipped archive waited for the
 * conversation's next open (review of #2726).
 */
describe('archive replays a restore skipped on a link known down', () => {
  beforeEach(() => {
    connectivity.reset();
    // Node's `navigator` has no `onLine`, which `reset` reads as "no network": start online.
    connectivity.isOnline = true;
    // Node has no `localStorage`; no stream cursor held, so each load goes straight to the replay.
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  afterEach(() => {
    connectivity.reset();
    vi.unstubAllGlobals();
  });

  /** A restore that seeds `g-1` and reports its archive replay skipped. */
  function restoreThatSkips() {
    loadExistingConversations.mockImplementation(
      async (args: {
        conversations: Map<string, unknown>;
        onArchiveReplaysSkipped?: (ids: string[]) => void;
      }) => {
        args.conversations.set('g-1', { id: 'g-1', messages: [] });
        args.onArchiveReplaysSkipped?.(['g-1']);
      }
    );
  }

  const replayLines = (ctx: never) =>
    (ctx as unknown as { log: ReturnType<typeof vi.fn> }).log.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes('[CATCHUP] link back'));

  it('replays them at the first reconnect the server answers, and only then', async () => {
    restoreThatSkips();
    const convs = useConversations();
    const ctx = makeCtx();
    connectivity.notifyServerUnreachable();

    await convs.loadAndRestoreConversations(ctx);
    expect(replayLines(ctx)).toEqual([]);

    connectivity.notifyServerReachable();
    await settle();
    expect(replayLines(ctx)).toEqual([
      '[CATCHUP] link back - replaying 1 archive(s) skipped while it was down',
    ]);

    // ONCE: a later edge owes nothing.
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await settle();
    expect(replayLines(ctx)).toHaveLength(1);
  });

  it('re-owes what is left when the link drops mid-replay, and replays it at the next reconnect', async () => {
    loadExistingConversations.mockImplementation(
      async (args: {
        conversations: Map<string, unknown>;
        onArchiveReplaysSkipped?: (ids: string[]) => void;
      }) => {
        args.conversations.set('g-1', { id: 'g-1', messages: [] });
        args.conversations.set('g-2', { id: 'g-2', messages: [] });
        args.onArchiveReplaysSkipped?.(['g-1', 'g-2']);
      }
    );
    const convs = useConversations();
    const ctx = makeCtx();
    connectivity.notifyServerUnreachable();
    await convs.loadAndRestoreConversations(ctx);
    expect(withMlsBulkIngest).not.toHaveBeenCalled();

    // The first archive's read gets no answer: the link is known down again.
    withMlsBulkIngest.mockImplementationOnce(async () => {
      connectivity.notifyServerUnreachable();
    });
    connectivity.notifyServerReachable();
    await settle();
    await settle();
    expect(withMlsBulkIngest).toHaveBeenCalledTimes(1);
    const lines = (ctx as unknown as { log: ReturnType<typeof vi.fn> }).log.mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(lines.filter((l) => l.includes('dropped again'))).toEqual([
      '[CATCHUP] the link dropped again - 1 archive replay(s) owed to the next reconnect',
    ]);

    // The next answered reconnect replays the one left, and only it.
    connectivity.notifyServerReachable();
    await settle();
    await settle();
    expect(withMlsBulkIngest).toHaveBeenCalledTimes(2);
    expect(replayLines(ctx)).toEqual([
      '[CATCHUP] link back - replaying 2 archive(s) skipped while it was down',
      '[CATCHUP] link back - replaying 1 archive(s) skipped while it was down',
    ]);
    vi.unstubAllGlobals();
  });

  // The fast path's store reads throw OUT of the load (outside its own catch): said, and the ids
  // after it are still replayed - an escape under `void` would end them all, unlogged.
  it('logs an archive whose load throws and goes on to the next', async () => {
    loadExistingConversations.mockImplementation(
      async (args: {
        conversations: Map<string, unknown>;
        onArchiveReplaysSkipped?: (ids: string[]) => void;
      }) => {
        args.conversations.set('g-1', { id: 'g-1', messages: [] });
        args.conversations.set('g-2', { id: 'g-2', messages: [] });
        args.onArchiveReplaysSkipped?.(['g-1', 'g-2']);
      }
    );
    let reads = 0;
    vi.stubGlobal('localStorage', {
      getItem: () => {
        reads++;
        if (reads === 1) throw new Error('storage refused');
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    });
    const convs = useConversations();
    const ctx = makeCtx();
    connectivity.notifyServerUnreachable();
    await convs.loadAndRestoreConversations(ctx);

    connectivity.notifyServerReachable();
    await settle();
    await settle();

    const lines = (ctx as unknown as { log: ReturnType<typeof vi.fn> }).log.mock.calls.map(
      (c: unknown[]) => String(c[0])
    );
    expect(lines).toContain('[CATCHUP] owed archive replay of g-1 failed: Error: storage refused');
    expect(withMlsBulkIngest).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('drops what a sign-out left owed', async () => {
    restoreThatSkips();
    const convs = useConversations();
    const ctx = makeCtx();
    connectivity.notifyServerUnreachable();
    await convs.loadAndRestoreConversations(ctx);

    convs.invalidateRestores();
    connectivity.notifyServerReachable();
    await settle();

    expect(replayLines(ctx)).toEqual([]);
  });
});
