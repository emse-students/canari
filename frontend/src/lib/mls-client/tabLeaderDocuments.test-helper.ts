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
 * The browser's lock manager for one lock name: one holder, a FIFO queue, `ifAvailable`, `signal`,
 * and `steal` (the holder's request rejects with `AbortError` and the stealer holds at once).
 */
export function fakeLockManager(onGrant?: () => void) {
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
    // The instant the browser hands the lock on, before the new holder's callback runs.
    onGrant?.();
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
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface Doc {
  mod: typeof import('./tabLeader');
  /** This document's own `stateAuthority` - the fact #3371 reads before every MLS state write. */
  auth: typeof import('./stateAuthority');
  /** Dispatches a lifecycle event to THIS document only. */
  fire: (type: string, event?: unknown) => void;
  logs: string[];
  promoted: number;
  demoted: number;
  /** Why each demotion happened, in order. */
  demotions: TabDemotionCause[];
}

/**
 * Loads a fresh instance of the module - one document - and records the listeners it registers, so
 * an event can be dispatched to it and not to the other.
 */
export async function openDocument(opts: { reloadsOnDemotion?: boolean } = {}): Promise<Doc> {
  vi.resetModules();
  const mod = await import('./tabLeader');
  // Imported in the same module generation, so it reads THIS document's election.
  const auth = await import('./stateAuthority');
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
    fire: (type, event = {}) =>
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(event)),
    logs: [],
    promoted: 0,
    demoted: 0,
    demotions: [],
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
  await mod.initTabLeadershipAsync((m) => doc.logs.push(m));
  await settle();
  // What the login does right after the election, before it reads the state (`sessionAuth`).
  auth.noteMlsStateLoaded(mod.getIsTabLeader());
  docAdd.mockRestore();
  winAdd.mockRestore();
  return doc;
}

/**
 * The browser's BroadcastChannel between the documents of one test, delivered on a microtask so
 * {@link settle} lets every message arrive: Node's own channel crosses event-loop turns, and a test
 * that waited for it with a timer passed or failed with the machine's load.
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
      queueMicrotask(() => peer.listeners.forEach((l) => l({ data } as MessageEvent)));
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
