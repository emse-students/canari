// @vitest-environment happy-dom
/**
 * A FROZEN LEADER HOLDS NOTHING (owner's log, web 1.6.9, 2026-11-10).
 *
 * The visible tab was a follower; the leader was a hidden tab the browser had frozen. It still held
 * the Web Lock, so the visible tab could neither connect nor send: a photo queued there asked the
 * leader twenty times and nothing answered, for two hours and across reloads.
 *
 * Two DOCUMENTS here, as in the browser: two fresh instances of `tabLeader.ts` (module state is per
 * document), one lock manager they share (the browser's, with its queue, its abort and its release
 * when the holder's callback settles), and the lifecycle events each document registered, so the
 * browser can freeze ONE of them. Nothing is stubbed inside the module.
 */

type Listener = (event: unknown) => void;
type LockCallback = (lock: { mode: string } | null) => unknown;

/**
 * The browser's lock manager for one lock name: one holder, a FIFO queue, `ifAvailable`, `signal`,
 * and `steal` (the holder's request rejects with `AbortError` and the stealer holds at once).
 */
function fakeLockManager() {
  type Entry = { cb: LockCallback; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  let holder: Entry | null = null;
  let grants = 0;
  const queue: Entry[] = [];

  function next(): void {
    const following = queue.shift();
    if (following) run(following);
  }

  function run(entry: Entry): void {
    holder = entry;
    grants += 1;
    void Promise.resolve()
      .then(() => entry.cb({ mode: 'exclusive' }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        // A holder whose lock was stolen releases nothing when its callback ends.
        if (holder !== entry) return;
        holder = null;
        next();
      });
  }

  const request = (
    _name: string,
    opts: { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean },
    cb: LockCallback
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const entry: Entry = { cb, resolve, reject };
      if (opts.steal) {
        const robbed = holder;
        holder = null;
        robbed?.reject(Object.assign(new Error('stolen'), { name: 'AbortError' }));
        run(entry);
        return;
      }
      if (opts.ifAvailable) {
        if (holder) {
          void Promise.resolve(cb(null)).then(resolve, reject);
          return;
        }
        run(entry);
        return;
      }
      if (!holder) {
        run(entry);
        return;
      }
      queue.push(entry);
      opts.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(entry);
        if (at === -1) return;
        queue.splice(at, 1);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  return {
    locks: { request },
    queued: () => queue.length,
    isHeld: () => holder !== null,
    grants: () => grants,
  };
}

/** Lets every queued microtask and lock hand-off run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface Doc {
  mod: typeof import('./tabLeader');
  /** Dispatches a lifecycle event to THIS document only. */
  fire: (type: string, event?: unknown) => void;
  logs: string[];
  promoted: number;
  demoted: number;
}

/**
 * Loads a fresh instance of the module - one document - and records the listeners it registers, so
 * an event can be dispatched to it and not to the other.
 */
async function openDocument(opts: { reloadsOnDemotion?: boolean } = {}): Promise<Doc> {
  vi.resetModules();
  const mod = await import('./tabLeader');
  const listeners: Array<{ type: string; fn: Listener }> = [];
  const docAdd = vi
    .spyOn(document, 'addEventListener')
    .mockImplementation(((type: string, fn: Listener) =>
      listeners.push({ type, fn })) as typeof document.addEventListener);
  const winAdd = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation(((type: string, fn: Listener) =>
      listeners.push({ type, fn })) as typeof window.addEventListener);
  const doc: Doc = {
    mod,
    fire: (type, event = {}) =>
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(event)),
    logs: [],
    promoted: 0,
    demoted: 0,
  };
  mod.setTabLeaderPromotedHandler(() => {
    doc.promoted += 1;
  });
  // What the session does: a demoted document reloads, so it neither queues nor takes the lead back.
  // A document with no session (before its login) has no reload to announce.
  mod.setTabLeaderDemotedHandler(() => {
    doc.demoted += 1;
    return opts.reloadsOnDemotion === false ? undefined : 'reloads';
  });
  await mod.initTabLeadershipAsync((m) => doc.logs.push(m));
  await settle();
  docAdd.mockRestore();
  winAdd.mockRestore();
  return doc;
}

describe('tabLeader - a document the browser suspends gives up the lead', () => {
  let manager: ReturnType<typeof fakeLockManager>;
  const origLocks = navigator.locks;

  beforeEach(() => {
    manager = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager.locks });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    vi.restoreAllMocks();
  });

  it('a frozen leader releases the lock, and the waiting tab is promoted', async () => {
    const hidden = await openDocument();
    const visible = await openDocument();
    expect(hidden.mod.getTabLeadership()).toBe('leader');
    expect(visible.mod.getTabLeadership()).toBe('follower');
    expect(manager.queued()).toBe(1);

    hidden.fire('freeze');
    await settle();

    // THE DEFECT: without the freeze handler the hidden tab kept the lock for ever and the visible
    // one stayed a follower - no socket, no send.
    expect(visible.mod.getTabLeadership()).toBe('leader');
    expect(visible.promoted).toBe(1);
    // ...and the frozen one is a follower BEFORE the lock moved, so nothing it resumes into writes.
    expect(hidden.mod.getTabLeadership()).toBe('follower');
    expect(hidden.mod.getIsTabLeader()).toBe(false);
    expect(hidden.demoted).toBe(1);
    expect(
      hidden.logs.some((l) => l.includes('Page suspended by the browser (freeze) while leading'))
    ).toBe(true);
  });

  it('a former leader resumed after its freeze does not take the lead back - its reload does not either', async () => {
    const hidden = await openDocument();
    const visible = await openDocument();
    hidden.fire('freeze');
    await settle();

    hidden.fire('resume');
    await settle();

    expect(visible.mod.getTabLeadership()).toBe('leader');
    expect(hidden.mod.getTabLeadership()).toBe('follower');
    expect(manager.queued()).toBe(0);
  });

  it('a frozen FOLLOWER withdraws its request, so the lock is never granted to a page that cannot run', async () => {
    const leader = await openDocument();
    const frozen = await openDocument();
    expect(manager.queued()).toBe(1);

    frozen.fire('freeze');
    await settle();
    expect(manager.queued()).toBe(0);

    // The leader closes while the follower is frozen: nobody is handed a lock it cannot use.
    leader.fire('beforeunload');
    await settle();
    expect(frozen.mod.getTabLeadership()).toBe('follower');
    expect(manager.isHeld()).toBe(false);

    // Resumed, it queues again and, the lock being free, is promoted.
    frozen.fire('resume');
    await settle();
    expect(frozen.mod.getTabLeadership()).toBe('leader');
    expect(frozen.promoted).toBe(1);
  });

  it('a leader going into the back/forward cache releases as a freeze does; a plain pagehide does not', async () => {
    const leader = await openDocument();
    const waiting = await openDocument();

    leader.fire('pagehide', { persisted: false });
    await settle();
    expect(leader.mod.getTabLeadership()).toBe('leader');

    leader.fire('pagehide', { persisted: true });
    await settle();
    expect(waiting.mod.getTabLeadership()).toBe('leader');
    expect(leader.mod.getTabLeadership()).toBe('follower');
  });

  it('a second freeze of a former leader demotes nothing again', async () => {
    const leader = await openDocument();
    await openDocument();
    leader.fire('freeze');
    await settle();
    leader.fire('freeze');
    await settle();
    expect(leader.demoted).toBe(1);
  });

  it('a leader whose demotion does not reload it queues again - but not while frozen', async () => {
    const leader = await openDocument({ reloadsOnDemotion: false });
    const other = await openDocument();
    leader.fire('freeze');
    await settle();
    // Its hand-over queued it again; a frozen page's request is withdrawn like any follower's.
    expect(other.mod.getTabLeadership()).toBe('leader');
    expect(manager.queued()).toBe(0);

    leader.fire('resume');
    await settle();
    expect(manager.queued()).toBe(1);
    expect(leader.mod.getTabLeadership()).toBe('follower');
  });
});

/**
 * FIREFOX HAS NO `freeze` EVENT (owner, Firefox 159, 2026-11-10): the photo queued in the visible
 * follower stayed unsent until the hidden leader tab was brought forward. The portable path is an
 * explicit hand-over, asked by the visible tab that needs it and granted by a HIDDEN leader.
 */
describe('tabLeader - a hidden leader hands the lead to the visible tab that asks', () => {
  let manager: ReturnType<typeof fakeLockManager>;
  const origLocks = navigator.locks;
  let visibility: DocumentVisibilityState = 'visible';

  /** Both documents read the one `document` here, so the test sets what the reader would see. */
  function seen(state: DocumentVisibilityState): void {
    visibility = state;
  }

  /** BroadcastChannel delivers on a later task. */
  async function deliver(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
    }
  }

  beforeEach(() => {
    manager = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager.locks });
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    // Back to happy-dom's own property.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
  });

  it('the asker - not the first tab in the queue - takes the lead, and the old leader is a follower first', async () => {
    const hidden = await openDocument();
    const queuedFirst = await openDocument();
    const asker = await openDocument();
    expect(manager.queued()).toBe(2);

    // The asker is the one the member looks at; by the time the leader reads the ask, it is hidden.
    seen('visible');
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    seen('hidden');
    await deliver();

    expect(asker.mod.getTabLeadership()).toBe('leader');
    expect(asker.promoted).toBe(1);
    expect(hidden.mod.getTabLeadership()).toBe('follower');
    expect(hidden.demoted).toBe(1);
    expect(hidden.logs.some((l) => l.includes('Hidden leader asked for the lead'))).toBe(true);
    // Granted through the queue, the lock would have gone to another background tab.
    expect(queuedFirst.mod.getTabLeadership()).toBe('follower');
    expect(queuedFirst.promoted).toBe(0);
  });

  it('a VISIBLE leader keeps the lead: it is serving', async () => {
    const leader = await openDocument();
    const asker = await openDocument();

    seen('visible');
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    await deliver();

    expect(leader.mod.getTabLeadership()).toBe('leader');
    expect(asker.mod.getTabLeadership()).toBe('follower');
    expect(leader.demoted).toBe(0);
  });

  it('a hidden follower does not ask', async () => {
    const leader = await openDocument();
    const asker = await openDocument();

    seen('hidden');
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    await deliver();

    expect(leader.mod.getTabLeadership()).toBe('leader');
    expect(asker.logs.some((l) => l.includes('asked for the lead'))).toBe(false);
  });

  it('the ask repeats but is said once while visible, and a leader hidden since answers the next one', async () => {
    const leader = await openDocument();
    const asker = await openDocument();
    seen('visible');
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    await deliver();
    expect(
      asker.logs.filter((l) => l.includes('a hidden leader is asked for the lead'))
    ).toHaveLength(1);
    expect(leader.mod.getTabLeadership()).toBe('leader');

    // The leader goes to the background; the next ask of the still-visible tab is answered.
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    seen('hidden');
    await deliver();
    expect(asker.mod.getTabLeadership()).toBe('leader');
    expect(leader.mod.getTabLeadership()).toBe('follower');
  });
});
