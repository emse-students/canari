import type { TabCommitEvent } from '$lib/mls-client/tabMessageSync';
import {
  createDelegationClient,
  createDelegationServer,
  type DelegatedCommitExecutors,
  type DelegationEnv,
  type DelegationLocks,
} from './tabCommitDelegation';

/**
 * A FOLLOWER TAB'S COMMIT, DONE BY THE LEADER - two tabs simulated in one realm.
 *
 * What is modelled rather than stubbed, because the guarantees live there: ONE shared store (the
 * origin's `localStorage`), ONE lock manager whose locks belong to a DOCUMENT and are released when
 * that document dies (the browser's proof of death), and ONE channel that never delivers to the
 * document that posted (a `BroadcastChannel`). A stub answering "free" or "held" would pass over the
 * very races this module exists for.
 */

/** A `Storage` over a Map, shared by every simulated tab. */
function sharedStore(): DelegationEnv['store'] & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}

/** Exclusive Web Locks, owned by documents; `kill(doc)` releases everything that document held. */
function lockManager() {
  const holders = new Map<string, string>();
  const queues = new Map<string, Array<() => void>>();
  const releasers = new Map<string, Array<() => void>>();

  function release(name: string): void {
    holders.delete(name);
    const next = queues.get(name)?.shift();
    next?.();
  }

  function forDocument(doc: string): DelegationLocks {
    return {
      request<T>(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: unknown) => Promise<T> | T
      ): Promise<T> {
        const run = (): Promise<T> => {
          holders.set(name, doc);
          let released = false;
          const done = () => {
            if (released) return;
            released = true;
            release(name);
          };
          const list = releasers.get(doc) ?? [];
          list.push(done);
          releasers.set(doc, list);
          return Promise.resolve()
            .then(() => callback({ name }))
            .finally(done);
        };
        if (!holders.has(name)) return run();
        if (options.ifAvailable) return Promise.resolve(callback(null));
        return new Promise<T>((resolve, reject) => {
          const queue = queues.get(name) ?? [];
          queue.push(() => run().then(resolve, reject));
          queues.set(name, queue);
        });
      },
    };
  }

  return {
    forDocument,
    held: (name: string) => holders.has(name),
    /** The document goes away: every lock it holds is released, by the browser. */
    kill(doc: string) {
      for (const done of releasers.get(doc) ?? []) done();
      releasers.delete(doc);
    },
  };
}

/** A BroadcastChannel: delivers to every OTHER subscribed document, never back to the poster. */
function channelBus() {
  const subscribers = new Map<string, Set<(e: TabCommitEvent) => void>>();
  return {
    post(from: string, event: TabCommitEvent) {
      for (const [doc, handlers] of subscribers) {
        if (doc === from) continue;
        for (const h of handlers) queueMicrotask(() => h(event));
      }
    },
    subscribe(doc: string, handler: (e: TabCommitEvent) => void) {
      const set = subscribers.get(doc) ?? new Set();
      set.add(handler);
      subscribers.set(doc, set);
      return () => set.delete(handler);
    },
    deafen(doc: string) {
      subscribers.delete(doc);
    },
  };
}

/** One simulated tab. */
function tab(
  doc: string,
  world: {
    store: ReturnType<typeof sharedStore>;
    locks: ReturnType<typeof lockManager>;
    bus: ReturnType<typeof channelBus>;
  },
  role: { leader: boolean; account?: string }
) {
  let n = 0;
  const env: DelegationEnv = {
    store: world.store,
    locks: world.locks.forDocument(doc),
    post: (e) => world.bus.post(doc, e),
    subscribe: (h) => world.bus.subscribe(doc, h),
    account: () => role.account ?? 'alice',
    isLeader: () => role.leader,
    newId: () => `${doc}-req-${++n}`,
    log: () => {},
  };
  return {
    env,
    role,
    client: createDelegationClient(env),
    server: createDelegationServer(env),
    kill() {
      world.bus.deafen(doc);
      world.locks.kill(doc);
    },
  };
}

function world() {
  return { store: sharedStore(), locks: lockManager(), bus: channelBus() };
}

/** Lets every queued microtask and promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Executors that record every run, answering at once unless told to hang. */
function recordingExecutors() {
  const runs: string[] = [];
  const executors: DelegatedCommitExecutors = {
    'create-group': async ({ name }) => {
      runs.push(`create-group:${name}`);
      return { ok: true, key: `g-${name}` };
    },
    'start-direct': async ({ contact }) => {
      runs.push(`start-direct:${contact}`);
      return { ok: true, key: `dm-${contact}` };
    },
    invite: async ({ groupId, memberIds }) => {
      runs.push(`invite:${groupId}:${memberIds.join(',')}`);
      return { kind: 'added', addedUsers: memberIds };
    },
    remove: async ({ groupId, memberId }) => {
      runs.push(`remove:${groupId}:${memberId}`);
      return 'committed';
    },
    'enter-community-key-group': async ({ workspaceId }) => {
      runs.push(`key-group:${workspaceId}`);
      return 'entered';
    },
    'enter-salon-group': async ({ channelId }) => {
      runs.push(`salon:${channelId}`);
      return 'entered';
    },
  };
  return { runs, executors };
}

describe('a follower tab hands its commits to the leader tab', () => {
  it.each([
    [
      { kind: 'create-group', name: 'club' } as const,
      'create-group:club',
      { ok: true, key: 'g-club' },
    ],
    [
      { kind: 'start-direct', contact: 'bob' } as const,
      'start-direct:bob',
      { ok: true, key: 'dm-bob' },
    ],
    [
      { kind: 'invite', groupId: 'g1', memberIds: ['bob'] } as const,
      'invite:g1:bob',
      { kind: 'added', addedUsers: ['bob'] },
    ],
    [{ kind: 'remove', groupId: 'g1', memberId: 'bob' } as const, 'remove:g1:bob', 'committed'],
    [{ kind: 'enter-community-key-group', workspaceId: 'w1' } as const, 'key-group:w1', 'entered'],
    [
      { kind: 'enter-salon-group', workspaceId: 'w1', channelId: 's1', isPrivate: true } as const,
      'salon:s1',
      'entered',
    ],
  ])('%o is run ONCE by the leader and its answer reaches the follower', async (op, run, value) => {
    const w = world();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    const { runs, executors } = recordingExecutors();
    leader.server.listen();
    leader.server.register(executors);

    const outcome = await follower.client(op as never);

    expect(outcome).toEqual({ status: 'done', value });
    expect(runs).toEqual([run]);
    // The follower deleted the answered record: nothing is left behind.
    expect(w.store.keys()).toEqual([]);
  });

  it('a follower never runs anything itself, whatever it registered', async () => {
    const w = world();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    const onLeader = recordingExecutors();
    const onFollower = recordingExecutors();
    leader.server.listen();
    follower.server.listen();
    leader.server.register(onLeader.executors);
    follower.server.register(onFollower.executors);

    await follower.client({ kind: 'invite', groupId: 'g1', memberIds: ['bob'] });

    expect(onLeader.runs).toHaveLength(1);
    expect(onFollower.runs).toEqual([]);
  });
});

describe('one request, one commit', () => {
  it('a repeated signal and repeated drains run the request once', async () => {
    const w = world();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    const { runs, executors } = recordingExecutors();
    leader.server.listen();
    leader.server.register(executors);

    const answer = follower.client({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    // The follower's signal, repeated - as a retry would - and the leader draining on its own.
    follower.env.post({ type: 'tab_commit_requested', id: 'F-req-1' });
    follower.env.post({ type: 'tab_commit_requested', id: 'F-req-1' });
    await Promise.all([leader.server.drain('again'), leader.server.drain('and again')]);

    expect(await answer).toEqual({ status: 'done', value: 'committed' });
    await leader.server.drain('after the answer');
    expect(runs).toEqual(['remove:g1:bob']);
  });

  it('two documents that both believe they lead run the request once between them', async () => {
    // A stolen lock's old leader can still be finishing JavaScript when the new one drains.
    const w = world();
    const a = tab('A', w, { leader: true });
    const b = tab('B', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    const onA = recordingExecutors();
    const onB = recordingExecutors();
    a.server.register(onA.executors);
    b.server.register(onB.executors);

    const answer = follower.client({ kind: 'create-group', name: 'club' });
    await settle();
    await Promise.all([a.server.drain('a'), b.server.drain('b')]);

    expect((await answer).status).toBe('done');
    expect(onA.runs.length + onB.runs.length).toBe(1);
  });

  it('a request made before any leader could run it is run by the leader that comes', async () => {
    const w = world();
    const follower = tab('F', w, { leader: false });
    const answer = follower.client({ kind: 'create-group', name: 'club' });
    await settle();

    // The leader's session comes up: its executors are registered, and that is what drains.
    const leader = tab('L', w, { leader: true });
    const { runs, executors } = recordingExecutors();
    leader.server.register(executors);

    expect(await answer).toEqual({ status: 'done', value: { ok: true, key: 'g-club' } });
    expect(runs).toEqual(['create-group:club']);
  });
});

describe('the leader goes away mid-request', () => {
  it('a request whose leader died while running it is answered leader-gone and NEVER run again', async () => {
    const w = world();
    const oldLeader = tab('L1', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    let started = 0;
    oldLeader.server.listen();
    oldLeader.server.register({
      remove: () => {
        started += 1;
        // The leader reached the server, and its document ended before it answered.
        return new Promise<never>(() => {});
      },
    });

    const answer = follower.client({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    await settle();
    expect(started).toBe(1);
    oldLeader.kill();

    // The handover elects another tab; its session comes up and it drains.
    const newLeader = tab('L2', w, { leader: true });
    const { runs, executors } = recordingExecutors();
    newLeader.server.register(executors);

    expect(await answer).toEqual({ status: 'refused', reason: 'leader-gone' });
    expect(runs).toEqual([]);
  });

  it('a request still running in a live document is waited for, never answered leader-gone', async () => {
    const w = world();
    const slow = tab('L1', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    let finish: (v: 'committed') => void = () => {};
    slow.server.listen();
    slow.server.register({
      remove: () => new Promise<'committed'>((resolve) => (finish = resolve)),
    });

    const answer = follower.client({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    await settle();

    // A second document that believes it leads drains meanwhile: the run lock is held.
    const other = tab('L2', w, { leader: true });
    const { runs, executors } = recordingExecutors();
    other.server.register(executors);
    await settle();

    finish('committed');
    expect(await answer).toEqual({ status: 'done', value: 'committed' });
    expect(runs).toEqual([]);
  });

  it('a follower that asked and then went away leaves no record behind', async () => {
    const w = world();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    let finish: (v: 'entered') => void = () => {};
    leader.server.listen();
    leader.server.register({
      'enter-community-key-group': () => new Promise<'entered'>((resolve) => (finish = resolve)),
    });

    void follower.client({ kind: 'enter-community-key-group', workspaceId: 'w1' });
    await settle();
    follower.kill();
    finish('entered');
    await settle();
    expect(w.store.keys()).toHaveLength(1);

    // The next drain finds the answered record with its requester gone, and removes it.
    await leader.server.drain('later');
    expect(w.store.keys()).toEqual([]);
  });
});

describe('the refusals that cannot be avoided', () => {
  it('a leader of ANOTHER account refuses the request and runs nothing', async () => {
    const w = world();
    const leader = tab('L', w, { leader: true, account: 'carol' });
    const follower = tab('F', w, { leader: false, account: 'alice' });
    const { runs, executors } = recordingExecutors();
    leader.server.listen();
    leader.server.register(executors);

    expect(await follower.client({ kind: 'create-group', name: 'club' })).toEqual({
      status: 'refused',
      reason: 'not-delegable',
    });
    expect(runs).toEqual([]);
  });

  it('an engine without Web Locks hands nothing over: no death could ever be proven', async () => {
    const w = world();
    const follower = tab('F', w, { leader: false });
    follower.env.locks = null;
    const client = createDelegationClient(follower.env);

    expect(await client({ kind: 'create-group', name: 'club' })).toEqual({
      status: 'refused',
      reason: 'not-delegable',
    });
    expect(w.store.keys()).toEqual([]);
  });

  it('an executor that throws instead of answering is settled failed, not left hanging', async () => {
    const w = world();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    leader.server.listen();
    leader.server.register({
      invite: async () => {
        throw new Error('a defect');
      },
    });

    expect(await follower.client({ kind: 'invite', groupId: 'g1', memberIds: ['bob'] })).toEqual({
      status: 'refused',
      reason: 'failed',
    });
    vi.restoreAllMocks();
  });
});
