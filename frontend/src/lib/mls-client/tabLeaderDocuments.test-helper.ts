/**
 * TWO DOCUMENTS OF ONE BROWSER, for the election's tests (`tabLeader.*.test.ts`).
 *
 * Module state is per document, so each document is a fresh instance of `tabLeader.ts` (and of the
 * `stateAuthority` that reads it); the lock manager is the browser's, shared, with its queue, its
 * abort, its steal and its release when the holder's callback settles; and the lifecycle events each
 * document registered are kept so the browser can dispatch one to ONE of them. Nothing is stubbed
 * inside the module.
 */
import { vi } from 'vitest';
import type { TabDemotionCause } from './tabLeader';

type Listener = (event: unknown) => void;
type LockCallback = (lock: { mode: string } | null) => unknown;

/**
 * The browser's lock manager: per lock NAME one holder, a FIFO queue, `ifAvailable`, `signal`, and
 * `steal` (the holder's request rejects with `AbortError` and the stealer holds at once), and `query`
 * (the names held). `queued`, `isHeld` and `grants` read the leader lock, `canari-tab-leader`.
 */
export function fakeLockManager(onGrant?: () => void) {
  type Entry = { cb: LockCallback; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  type Lock = { holder: Entry | null; queue: Entry[]; grants: number };
  const locks = new Map<string, Lock>();
  const lockOf = (name: string): Lock => {
    let lock = locks.get(name);
    if (!lock) {
      lock = { holder: null, queue: [], grants: 0 };
      locks.set(name, lock);
    }
    return lock;
  };

  function run(name: string, entry: Entry): void {
    const lock = lockOf(name);
    lock.holder = entry;
    lock.grants += 1;
    // The instant the browser hands the leader lock on, before the new holder's callback runs.
    if (name === LEADER_LOCK) onGrant?.();
    void Promise.resolve()
      .then(() => entry.cb({ mode: 'exclusive' }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        // A holder whose lock was stolen releases nothing when its callback ends.
        if (lock.holder !== entry) return;
        lock.holder = null;
        const following = lock.queue.shift();
        if (following) run(name, following);
      });
  }

  const request = (
    name: string,
    opts: { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean },
    cb: LockCallback
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const lock = lockOf(name);
      const entry: Entry = { cb, resolve, reject };
      if (opts.steal) {
        const robbed = lock.holder;
        lock.holder = null;
        robbed?.reject(Object.assign(new Error('stolen'), { name: 'AbortError' }));
        run(name, entry);
        return;
      }
      if (opts.ifAvailable) {
        if (lock.holder) {
          void Promise.resolve(cb(null)).then(resolve, reject);
          return;
        }
        run(name, entry);
        return;
      }
      if (!lock.holder) {
        run(name, entry);
        return;
      }
      lock.queue.push(entry);
      opts.signal?.addEventListener('abort', () => {
        const at = lock.queue.indexOf(entry);
        if (at === -1) return;
        lock.queue.splice(at, 1);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  const query = async () => ({
    held: [...locks].filter(([, lock]) => lock.holder !== null).map(([name]) => ({ name })),
    pending: [...locks].flatMap(([name, lock]) => lock.queue.map(() => ({ name }))),
  });

  return {
    locks: { request, query },
    queued: () => lockOf(LEADER_LOCK).queue.length,
    isHeld: () => lockOf(LEADER_LOCK).holder !== null,
    grants: () => lockOf(LEADER_LOCK).grants,
    /** Whether a tab holds the serving lock (`tabLeader.ts`, `SERVING_LOCK`). */
    serving: () => lockOf('canari-tab-serving').holder !== null,
  };
}

const LEADER_LOCK = 'canari-tab-leader';

/** Lets every queued microtask and lock hand-off run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface Doc {
  mod: typeof import('./tabLeader');
  /** This document's own `stateAuthority` - the fact #3371 reads before every MLS state write. */
  auth: typeof import('./stateAuthority');
  /** This document's own lead holds (`leadHolds.ts`): the MLS work that keeps its lead. */
  holds: typeof import('./leadHolds');
  /** Dispatches a lifecycle event to THIS document only. */
  fire: (type: string, event?: unknown) => void;
  logs: string[];
  promoted: number;
  demoted: number;
  /** Why each demotion happened, in order. */
  demotions: TabDemotionCause[];
  /** The login's election, settled once its answer is noted as the load's role (`stateAuthority`). */
  elected: Promise<boolean>;
}

/**
 * Loads a fresh instance of the module - one document - and records the listeners it registers, so
 * an event can be dispatched to it and not to the other.
 */
export async function openDocument(
  opts: {
    reloadsOnDemotion?: boolean;
    /**
     * Returns before the election is answered - a page whose login WAITS for the lead (reloaded after
     * its promotion, while no tab serves it). Its listeners are recorded up to the election's first
     * wait; the lock hold it registers on a later grant is on the window (`unload` dispatches it).
     */
    pending?: boolean;
  } = {}
): Promise<Doc> {
  vi.resetModules();
  const mod = await import('./tabLeader');
  // Imported in the same module generation, so it reads THIS document's election.
  const auth = await import('./stateAuthority');
  const holds = await import('./leadHolds');
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
    auth,
    holds,
    fire: (type, event = {}) =>
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(event)),
    logs: [],
    promoted: 0,
    demoted: 0,
    demotions: [],
    elected: Promise.resolve(false),
  };
  mod.setTabLeaderPromotedHandler(() => {
    doc.promoted += 1;
  });
  // What the session does: a demoted document reloads, so it neither queues nor takes the lead back.
  // A document with no session (before its login) has no reload to announce.
  // A lead given up because the session cannot serve reloads nothing (`useChatSession`).
  mod.setTabLeaderDemotedHandler((cause) => {
    doc.demoted += 1;
    doc.demotions.push(cause);
    if (cause === 'session-cannot-serve') return undefined;
    return opts.reloadsOnDemotion === false ? undefined : 'reloads';
  });
  // What the login does right after the election, before it reads the state (`sessionAuth`): it
  // loads with the answer it was handed.
  doc.elected = mod
    .initTabLeadershipAsync((m) => doc.logs.push(m))
    .then((lead) => {
      auth.noteMlsStateLoaded(lead);
      return lead;
    });
  if (!opts.pending) {
    await doc.elected;
    await settle();
  }
  docAdd.mockRestore();
  winAdd.mockRestore();
  return doc;
}

/**
 * The browser's BroadcastChannel between the documents of one test, delivered as the real one is: on
 * a LATER TASK than the post (so a lock released in the same task can be granted first), and never
 * to a channel closed before delivery. Unlike Node's own channel - which crosses threads and made a
 * test pass or fail with the machine's load - its tasks are this thread's timers, in order, so
 * {@link deliverBroadcasts} delivers every message posted before it, deterministically.
 */
export class FakeBroadcastChannel {
  private static readonly open = new Map<string, Set<FakeBroadcastChannel>>();
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.open.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.open.set(name, peers);
  }
  postMessage(data: unknown): void {
    for (const peer of FakeBroadcastChannel.open.get(this.name) ?? []) {
      if (peer === this) continue;
      setTimeout(() => {
        if (!FakeBroadcastChannel.open.get(this.name)?.has(peer)) return;
        peer.listeners.forEach((l) => l({ data } as MessageEvent));
      }, 0);
    }
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  close(): void {
    FakeBroadcastChannel.open.get(this.name)?.delete(this);
  }
  /** Forgets every channel, between tests. */
  static reset(): void {
    FakeBroadcastChannel.open.clear();
  }
}

/** Runs the tasks that deliver every broadcast posted so far, then every microtask they started. */
export async function deliverBroadcasts(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
}
