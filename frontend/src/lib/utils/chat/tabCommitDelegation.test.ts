import type { TabCommitEvent } from '$lib/mls-client/tabMessageSync';
import {
  createDelegationClient,
  createDelegationServer,
  type DelegatedCommitExecutors,
  type DelegationEnv,
  type DelegationLocks,
  type DelegationReadiness,
  type DelegationRecord,
} from './tabCommitDelegation';
import type { TabCommitStore } from './tabCommitStore';

/**
 * A FOLLOWER TAB'S COMMIT, DONE BY THE LEADER - two tabs simulated in one realm.
 *
 * What is modelled rather than stubbed, because the guarantees live there: ONE set of databases (the
 * origin's IndexedDB, each write visible to another document only once committed, turns later), ONE
 * lock manager whose locks belong to a DOCUMENT and are released when that document dies (the
 * browser's proof of death), and ONE channel that never delivers to the document that posted and
 * delivers to the others a turn later (a `BroadcastChannel`). A stub answering "free" or "held" would
 * pass over the very races this module exists for.
 */

/**
 * The origin's IndexedDB, as this module sees it: one database per ACCOUNT, every transaction
 * serialised (IndexedDB orders `readwrite` transactions over the same store), each one taking a
 * different number of turns to commit - and its write VISIBLE to other documents only once it has.
 * Records are copied in and out, as a structured clone would.
 */
function sharedDatabases() {
  const databases = new Map<string, Map<string, DelegationRecord>>();
  let turn = 0;
  /** A commit takes 1 to 4 turns, deterministically varied, so no two paths line up by accident. */
  const commitDelay = async () => {
    turn += 1;
    for (let i = 0; i < 1 + (turn % 4); i++) await new Promise((r) => setTimeout(r, 0));
  };
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  function storeFor(account: string): TabCommitStore<DelegationRecord> {
    let db = databases.get(account);
    if (!db) {
      db = new Map();
      databases.set(account, db);
    }
    const rows = db;
    let chain: Promise<unknown> = Promise.resolve();
    /** One transaction: runs after every earlier one of this database, commits after a delay. */
    const tx = <T>(body: () => T): Promise<T> => {
      const run = chain.then(async () => {
        const result = body();
        await commitDelay();
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    };
    return {
      get: (id) => tx(() => clone(rows.get(id)) ?? null),
      list: () => tx(() => [...rows.values()].map(clone)),
      put: (record) => tx(() => void rows.set(record.id, clone(record))),
      delete: (id) => tx(() => void rows.delete(id)),
      update: (id, change) =>
        tx(() => {
          const next = change(clone(rows.get(id)) ?? null);
          if (next === 'delete') {
            rows.delete(id);
            return null;
          }
          if (next !== null) rows.set(id, clone(next));
          return clone(rows.get(id)) ?? null;
        }),
    };
  }
  return {
    storeFor,
    /** Every record of every account, for the assertions. */
    ids: () => [...databases.values()].flatMap((rows) => [...rows.keys()]),
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
        for (const h of handlers) setTimeout(() => h(event), 0);
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

/** How a simulated document stands: its election, the role its MLS state was LOADED with, its session. */
interface Role {
  leader: boolean;
  loaded?: 'leader' | 'follower' | 'unknown';
  account?: string;
  readiness?: DelegationReadiness;
}

function makeWorld() {
  return { databases: sharedDatabases(), locks: lockManager(), bus: channelBus() };
}

/** One simulated tab. */
function tab(doc: string, world: ReturnType<typeof makeWorld>, role: Role) {
  let n = 0;
  const lines: { message: string; level?: 'warn' | 'error' }[] = [];
  const loaded = () => role.loaded ?? (role.leader ? 'leader' : 'follower');
  const env: DelegationEnv = {
    storeFor: world.databases.storeFor,
    locks: world.locks.forDocument(doc),
    post: (e) => world.bus.post(doc, e),
    subscribe: (h) => world.bus.subscribe(doc, h),
    account: () => role.account ?? 'alice',
    serves: () => role.leader && loaded() === 'leader',
    answers: () => role.leader && loaded() !== 'follower',
    readiness: () => role.readiness ?? 'ready',
    newId: () => `${doc}-req-${++n}`,
    log: (message, level) => void lines.push({ message, level }),
  };
  const client = createDelegationClient(env);
  return {
    env,
    role,
    lines,
    delegate: client.delegate,
    abandon: client.abandon,
    server: createDelegationServer(env),
    kill() {
      world.bus.deafen(doc);
      world.locks.kill(doc);
    },
  };
}

/** Lets every pending turn - commits, signals, lock hand-offs - run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Executors that record every run, answering at once. */
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

/** A leader whose session is up, listening, with every executor registered. */
function servingLeader(doc: string, w: ReturnType<typeof makeWorld>, role: Partial<Role> = {}) {
  const leader = tab(doc, w, { leader: true, ...role });
  const recorded = recordingExecutors();
  leader.server.listen();
  leader.server.register(recorded.executors);
  return { leader, runs: recorded.runs };
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
    const w = makeWorld();
    const { runs } = servingLeader('L', w);
    const follower = tab('F', w, { leader: false });

    const outcome = await follower.delegate(op as never);
    await settle();

    expect(outcome).toEqual({ status: 'done', value });
    expect(runs).toEqual([run]);
    // The follower deleted the answered record: nothing is left behind.
    expect(w.databases.ids()).toEqual([]);
  });

  it('a follower never runs anything itself, whatever it registered', async () => {
    const w = makeWorld();
    const { runs } = servingLeader('L', w);
    const follower = tab('F', w, { leader: false });
    const onFollower = recordingExecutors();
    follower.server.listen();
    follower.server.register(onFollower.executors);

    await follower.delegate({ kind: 'invite', groupId: 'g1', memberIds: ['bob'] });

    expect(runs).toHaveLength(1);
    expect(onFollower.runs).toEqual([]);
  });
});

describe('one request, one commit', () => {
  it('a repeated signal and repeated drains run the request once', async () => {
    const w = makeWorld();
    const { leader, runs } = servingLeader('L', w);
    const follower = tab('F', w, { leader: false });

    const answer = follower.delegate({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    await settle();
    // The follower's signal, repeated - as a retry would - and the leader draining on its own.
    follower.env.post({ type: 'tab_commit_requested', id: 'F-req-1', account: 'alice' });
    follower.env.post({ type: 'tab_commit_requested', id: 'F-req-1', account: 'alice' });
    await Promise.all([leader.server.drain('again'), leader.server.drain('and again')]);

    expect(await answer).toEqual({ status: 'done', value: 'committed' });
    await leader.server.drain('after the answer');
    await settle();
    expect(runs).toEqual(['remove:g1:bob']);
  });

  it('two documents that both believe they lead run the request once between them', async () => {
    // A stolen lock's old leader can still be finishing JavaScript when the new one drains.
    const w = makeWorld();
    const a = servingLeader('A', w);
    const b = servingLeader('B', w);
    const follower = tab('F', w, { leader: false });

    const answer = follower.delegate({ kind: 'create-group', name: 'club' });
    await Promise.all([a.leader.server.drain('a'), b.leader.server.drain('b')]);

    expect((await answer).status).toBe('done');
    await settle();
    expect(a.runs.length + b.runs.length).toBe(1);
  });

  it('a request made before any leader could run it is run by the leader that comes', async () => {
    const w = makeWorld();
    const follower = tab('F', w, { leader: false });
    const answer = follower.delegate({ kind: 'create-group', name: 'club' });
    await settle();

    // The leader's session comes up: its executors are registered, and that is what drains.
    const { runs } = servingLeader('L', w);

    expect(await answer).toEqual({ status: 'done', value: { ok: true, key: 'g-club' } });
    expect(runs).toEqual(['create-group:club']);
  });
});

describe('only a state LOADED as the leader runs a request', () => {
  it('a follower promoted in place runs and answers nothing; its reloaded successor runs it', async () => {
    const w = makeWorld();
    // P was a follower; its leader closed, so it leads now - on the copy it loaded as a follower.
    const promoted = servingLeader('P', w, { loaded: 'follower' });
    const follower = tab('F', w, { leader: false });

    const answer = follower.delegate({ kind: 'enter-community-key-group', workspaceId: 'w1' });
    await settle();
    await promoted.leader.server.drain('asked again');
    await settle();
    expect(promoted.runs).toEqual([]);
    expect(w.databases.ids()).toEqual(['F-req-1']);

    // Its promotion reload: the document goes, its successor loads the state as the leader.
    promoted.leader.kill();
    const reloaded = servingLeader('P2', w);

    expect(await answer).toEqual({ status: 'done', value: 'entered' });
    expect(reloaded.runs).toEqual(['key-group:w1']);
    expect(promoted.runs).toEqual([]);
  });

  it('a leader whose session is still starting keeps the request, and runs it once ready', async () => {
    const w = makeWorld();
    const { leader, runs } = servingLeader('L', w, { readiness: 'starting' });
    const follower = tab('F', w, { leader: false });

    const answer = follower.delegate({ kind: 'create-group', name: 'club' });
    await settle();
    expect(runs).toEqual([]);

    leader.role.readiness = 'ready';
    await leader.server.drain('the session is up');

    expect(await answer).toEqual({ status: 'done', value: { ok: true, key: 'g-club' } });
    expect(runs).toEqual(['create-group:club']);
  });
});

describe('a follower is answered by a leader that lives', () => {
  it.each([
    ['at the PIN gate, its state not loaded yet', 'unknown'],
    ['locked again after its session', 'leader'],
  ] as const)('a leader %s answers leader-unavailable and runs nothing', async (_, loaded) => {
    const w = makeWorld();
    const { runs } = servingLeader('L', w, { loaded, readiness: 'unavailable' });
    const follower = tab('F', w, { leader: false });

    expect(await follower.delegate({ kind: 'create-group', name: 'club' })).toEqual({
      status: 'refused',
      reason: 'leader-unavailable',
    });
    await settle();
    expect(runs).toEqual([]);
    expect(w.databases.ids()).toEqual([]);
  });

  it('a request no executor in the leader runs is answered not-delegable', async () => {
    const w = makeWorld();
    const leader = tab('L', w, { leader: true });
    leader.server.listen();
    leader.server.register({ invite: recordingExecutors().executors.invite });
    const follower = tab('F', w, { leader: false });

    expect(await follower.delegate({ kind: 'remove', groupId: 'g1', memberId: 'bob' })).toEqual({
      status: 'refused',
      reason: 'not-delegable',
    });
  });
});

describe('the leader goes away mid-request', () => {
  it('a request whose leader died while running it is answered leader-gone and NEVER run again', async () => {
    const w = makeWorld();
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

    const answer = follower.delegate({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    await settle();
    expect(started).toBe(1);
    oldLeader.kill();

    // The handover elects another tab; its session comes up and it drains.
    const { runs } = servingLeader('L2', w);

    expect(await answer).toEqual({ status: 'refused', reason: 'leader-gone' });
    expect(runs).toEqual([]);
  });

  it('a request still running in a live document is waited for, never answered leader-gone', async () => {
    const w = makeWorld();
    const slow = tab('L1', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    let finish: (v: 'committed') => void = () => {};
    slow.server.listen();
    slow.server.register({
      remove: () => new Promise<'committed'>((resolve) => (finish = resolve)),
    });

    const answer = follower.delegate({ kind: 'remove', groupId: 'g1', memberId: 'bob' });
    await settle();

    // A second document that believes it leads drains meanwhile: the run lock is held.
    const other = servingLeader('L2', w);
    await settle();

    finish('committed');
    expect(await answer).toEqual({ status: 'done', value: 'committed' });
    await settle();
    expect(other.runs).toEqual([]);
  });

  it('a follower that asked and then went away leaves no record behind', async () => {
    const w = makeWorld();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    let finish: (v: 'entered') => void = () => {};
    leader.server.listen();
    leader.server.register({
      'enter-community-key-group': () => new Promise<'entered'>((resolve) => (finish = resolve)),
    });

    void follower.delegate({ kind: 'enter-community-key-group', workspaceId: 'w1' });
    await settle();
    follower.kill();
    finish('entered');
    await settle();
    expect(w.databases.ids()).toHaveLength(1);

    // The next drain finds the answered record with its requester gone, and removes it.
    await leader.server.drain('later');
    expect(w.databases.ids()).toEqual([]);
  });
});

describe('a request nobody waits for is never run', () => {
  it('a PENDING request whose tab closed is deleted by the leader that comes, and not run', async () => {
    const w = makeWorld();
    const follower = tab('F', w, { leader: false });
    void follower.delegate({ kind: 'create-group', name: 'club' });
    await settle();
    follower.kill();

    const { leader, runs } = servingLeader('L', w);
    await settle();

    expect(runs).toEqual([]);
    expect(w.databases.ids()).toEqual([]);
    expect(leader.lines.some((l) => l.level === 'warn' && l.message.includes('NOT run'))).toBe(
      true
    );
  });

  it("a signed-out session's request is answered, deleted, and never run for the next one", async () => {
    const w = makeWorld();
    const follower = tab('F', w, { leader: false });
    const answer = follower.delegate({ kind: 'create-group', name: 'club' });
    await settle();

    expect(follower.abandon('signed out')).toBe(1);
    expect(await answer).toEqual({ status: 'refused', reason: 'leader-unavailable' });
    await settle();

    // The same account signs in again, and a leader comes: nothing of the old session runs.
    const { runs } = servingLeader('L', w);
    await settle();
    expect(runs).toEqual([]);
    expect(w.databases.ids()).toEqual([]);
  });
});

describe('the refusals that cannot be avoided', () => {
  it.each([
    ['signed in to another account', 'carol', 'not-delegable'],
    ['signed out', '', 'leader-unavailable'],
  ] as const)('a leader %s refuses the request and runs nothing', async (_, account, reason) => {
    const w = makeWorld();
    const { runs } = servingLeader('L', w, { account });
    const follower = tab('F', w, { leader: false, account: 'alice' });

    expect(await follower.delegate({ kind: 'create-group', name: 'club' })).toEqual({
      status: 'refused',
      reason,
    });
    expect(runs).toEqual([]);
  });

  it('an engine without Web Locks hands nothing over: no death could ever be proven', async () => {
    const w = makeWorld();
    const follower = tab('F', w, { leader: false });
    follower.env.locks = null;
    const client = createDelegationClient(follower.env);

    expect(await client.delegate({ kind: 'create-group', name: 'club' })).toEqual({
      status: 'refused',
      reason: 'not-delegable',
    });
    expect(w.databases.ids()).toEqual([]);
  });

  it('an executor that throws is settled failed, and said ONCE, at error', async () => {
    const w = makeWorld();
    const leader = tab('L', w, { leader: true });
    const follower = tab('F', w, { leader: false });
    leader.server.listen();
    leader.server.register({
      invite: async () => {
        throw new Error('a defect');
      },
    });

    const outcome = await follower.delegate({ kind: 'invite', groupId: 'g1', memberIds: ['bob'] });
    expect(outcome).toEqual({ status: 'refused', reason: 'failed' });
    const accusing = leader.lines.filter((l) => l.message.includes('a defect'));
    expect(accusing).toEqual([expect.objectContaining({ level: 'error' })]);
  });
});
