/**
 * A FOLLOWER TAB'S COMMIT, DONE BY THE LEADER (owner, 2026-11-08).
 *
 * Only the leader tab runs this device's MLS state (`tabLeader.ts`): a follower holds a copy loaded
 * once, which it cannot make durable and which the leader never learns from, so a commit is refused
 * in a follower at the service (`FollowerTabCommitError`). Until this module, that refusal was what
 * the member met - creating a conversation, inviting, removing, entering a community's or a salon's
 * key group all said "do it from the other tab". Now the follower HANDS THE GESTURE to the leader,
 * which runs it on its authoritative state exactly as its own gesture, and answers the outcome.
 *
 * THE SHAPE IS THE OUTBOX'S (`outbox.ts`, "Only the leader tab flushes"): the request is a DURABLE
 * RECORD both tabs read, and only a signal crosses `canari-tab-messages`. A record is
 *
 *   pending  -- written by the follower, the leader's to run;
 *   running  -- claimed by a leader, which holds the record's RUN LOCK (a Web Lock) for as long as it
 *               executes, and writes `done` before releasing it;
 *   done     -- carries the outcome; the follower that asked deletes it when it reads it.
 *
 * WHAT A LEADER THAT DIES MID-REQUEST LEAVES IS DECIDED BY THE BROWSER, NOT A CLOCK. A record found
 * `running` whose run lock is FREE was claimed by a document that ended without settling it - the
 * browser releases a lock when its document goes, so the free lock IS the proof of death (the
 * `salonUnsent.ts` rule). It is answered `leader-gone` and NEVER RUN AGAIN: the dead leader may have
 * reached the server (a record, a staged or sent commit) and its kept-commit machinery settles that
 * at the next connection; running the gesture a second time is how a removal or an Add would be
 * committed twice. A `pending` record, which no leader started, is run by whichever leader drains it
 * next - the one a handover elects included - so a request made just before a leader closed is not
 * lost. The member who got `leader-gone` is told so and checks before retrying.
 *
 * ONE REQUEST, ONE COMMIT. The record is keyed by the request id: a signal repeated, a drain run
 * twice, two documents draining at once (a stolen lock's old leader still finishing) all meet the
 * same record, and only the holder of its run lock, re-reading it under that lock, may move it from
 * `pending`. A `done` record is answered again, never run again.
 *
 * WHO CLEANS. The asking follower holds the record's REQUESTER LOCK while it waits and deletes the
 * record when it reads the outcome. A `done` record whose requester lock is free was asked by a
 * document that is gone (a follower promoted and reloaded, a closed tab): a drain deletes it.
 *
 * Two refusals are unavoidable and typed: `not-delegable` (no Web Locks in this engine, so no death
 * could ever be proven; or the leader tab is signed in to ANOTHER account - the lock is per browser,
 * not per account) and `failed` (an executor threw instead of answering, the visible end of a defect).
 */
import type { MemberRemovalOutcome } from '$lib/utils/chat/groupActions';
import type { BulkAdditionOutcome, ConversationOutcome } from '$lib/utils/chat/groupCreation';
import {
  postTabCommitEvent,
  subscribeTabCommitEvents,
  type TabCommitEvent,
} from '$lib/mls-client/tabMessageSync';
import { getIsTabLeader } from '$lib/mls-client/tabLeader';
import { currentUserId } from '$lib/stores/userState.svelte';

/** Every gesture a follower tab hands to the leader. */
export type DelegatedCommitOp =
  /** A named group conversation (`createNewGroup`). */
  | { kind: 'create-group'; name: string }
  /** A direct conversation with `contact` (`startNewConversation`). */
  | { kind: 'start-direct'; contact: string }
  /** An invitation of `memberIds` into `groupId` (`inviteMembersToGroup`). */
  | { kind: 'invite'; groupId: string; memberIds: string[] }
  /** The removal of `memberId` from `groupId` (`removeMemberAndBroadcast`). */
  | { kind: 'remove'; groupId: string; memberId: string }
  /** The community's Graine key group (`ensureCommunityDistributionGroup`). */
  | { kind: 'enter-community-key-group'; workspaceId: string }
  /** A salon's own key group, entered by a member who has access (`enterPrivateSalonGroup`). */
  | { kind: 'enter-salon-group'; workspaceId: string; channelId: string; isPrivate: boolean };

export type DelegatedCommitKind = DelegatedCommitOp['kind'];

/**
 * What a removal came to, as data: the thrown {@link MemberRemovalNotCommittedError} of the leader is
 * `recorded-not-committed` (the person is out, the key change completes at the next connection), any
 * other throw is `not-removed` (nothing recorded, the gesture can be retried).
 */
export type DelegatedRemovalResult =
  | MemberRemovalOutcome
  | 'recorded-not-committed'
  | 'not-removed';

/** What each gesture answers, as plain data a structured clone and JSON both carry. */
export interface DelegatedCommitResults {
  'create-group': ConversationOutcome;
  'start-direct': ConversationOutcome;
  invite: BulkAdditionOutcome;
  remove: DelegatedRemovalResult;
  'enter-community-key-group': 'entered';
  'enter-salon-group': 'entered';
}

/** Why the leader did not answer the gesture itself (see the module comment). */
export type DelegationRefusal = 'leader-gone' | 'not-delegable' | 'failed';

/** The outcome a follower receives for one request. */
export type DelegatedOutcome<K extends DelegatedCommitKind> =
  | { status: 'done'; value: DelegatedCommitResults[K] }
  | { status: 'refused'; reason: DelegationRefusal };

/** Runs one gesture on the leader. It answers by VALUE; a throw is a defect, settled `failed`. */
export type DelegatedCommitExecutors = {
  [K in DelegatedCommitKind]: (
    op: Extract<DelegatedCommitOp, { kind: K }>
  ) => Promise<DelegatedCommitResults[K]>;
};

/** One request as stored. */
interface DelegationRecord {
  id: string;
  /** The account of the follower that asked: a leader of another account cannot run it. */
  account: string;
  op: DelegatedCommitOp;
  state: 'pending' | 'running' | 'done';
  outcome?: DelegatedOutcome<DelegatedCommitKind>;
}

/** The subset of the Web Locks API this module uses. */
export interface DelegationLocks {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T
  ): Promise<T>;
}

/** Everything the mechanism touches, injected so two tabs can be simulated in one test. */
export interface DelegationEnv {
  store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
  /** Null where the engine has no Web Locks: nothing could prove a leader dead, so nothing is delegated. */
  locks: DelegationLocks | null;
  post(event: TabCommitEvent): void;
  subscribe(handler: (event: TabCommitEvent) => void): () => void;
  /** This tab's signed-in account, `''` when none. */
  account(): string;
  isLeader(): boolean;
  newId(): string;
  /** `warn` for every line that ACCUSES (a death, a refusal, a failure); info otherwise. */
  log(message: string, level?: 'warn'): void;
}

const RECORD_PREFIX = 'canari.tab-commit.';
const RUN_LOCK_PREFIX = 'canari.tab-commit.run.';
const REQUESTER_LOCK_PREFIX = 'canari.tab-commit.requester.';

function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

function readRecord(env: DelegationEnv, key: string): DelegationRecord | null {
  const raw = env.store.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as DelegationRecord;
  } catch (e) {
    // A record this module cannot read is one no tab will ever answer: removed, and said.
    env.log(
      `[TAB-COMMIT] ${key} is not a readable record - removed: ${String(e).slice(0, 80)}`,
      'warn'
    );
    env.store.removeItem(key);
    return null;
  }
}

function writeRecord(env: DelegationEnv, record: DelegationRecord): void {
  env.store.setItem(recordKey(record.id), JSON.stringify(record));
}

/** The keys of every stored request, read once - the store is not walked while it is written. */
function recordKeys(env: DelegationEnv): string[] {
  const keys: string[] = [];
  for (let i = 0; i < env.store.length; i++) {
    const key = env.store.key(i);
    if (key?.startsWith(RECORD_PREFIX)) keys.push(key);
  }
  return keys;
}

function describe(op: DelegatedCommitOp): string {
  switch (op.kind) {
    case 'create-group':
      return 'create-group';
    case 'start-direct':
      return 'start-direct';
    case 'invite':
      return `invite into ${op.groupId.slice(0, 8)}... (${op.memberIds.length})`;
    case 'remove':
      return `remove from ${op.groupId.slice(0, 8)}...`;
    case 'enter-community-key-group':
      return `key group of ${op.workspaceId.slice(0, 8)}...`;
    case 'enter-salon-group':
      return `salon group ${op.channelId.slice(0, 8)}...`;
  }
}

/**
 * The FOLLOWER half: hands `op` to the leader and resolves with its outcome. It never rejects - every
 * ending is an answer: done, or a typed refusal.
 */
export function createDelegationClient(env: DelegationEnv) {
  return function delegate<K extends DelegatedCommitKind>(
    op: Extract<DelegatedCommitOp, { kind: K }>
  ): Promise<DelegatedOutcome<K>> {
    const locks = env.locks;
    if (!locks) {
      env.log(
        `[TAB-COMMIT] ${describe(op)} not delegated: this engine has no Web Locks, so a leader that died mid-request could never be told from one still running`,
        'warn'
      );
      return Promise.resolve({ status: 'refused', reason: 'not-delegable' });
    }
    const id = env.newId();
    const key = recordKey(id);
    return new Promise<DelegatedOutcome<K>>((resolve) => {
      // THE REQUESTER LOCK IS TAKEN BEFORE THE RECORD EXISTS, so no drain can ever see the record
      // with the lock free while this document is alive and waiting.
      locks
        .request(
          `${REQUESTER_LOCK_PREFIX}${id}`,
          {},
          () =>
            new Promise<void>((release) => {
              let unsubscribe = () => {};
              const settleIfDone = () => {
                const record = readRecord(env, key);
                if (record === null) {
                  // Nothing but this document deletes a record whose requester is alive: a store
                  // wiped under it (a sign-out) is the only way here.
                  unsubscribe();
                  release();
                  env.log(
                    `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)}: the record vanished while waiting - answered failed`,
                    'warn'
                  );
                  resolve({ status: 'refused', reason: 'failed' });
                  return;
                }
                if (record.state !== 'done' || !record.outcome) return;
                unsubscribe();
                env.store.removeItem(key);
                release();
                env.log(
                  `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)} answered by the leader tab: ${record.outcome.status === 'done' ? 'done' : record.outcome.reason}`
                );
                resolve(record.outcome as DelegatedOutcome<K>);
              };
              unsubscribe = env.subscribe((event) => {
                if (event.type === 'tab_commit_settled' && event.id === id) settleIfDone();
              });
              writeRecord(env, { id, account: env.account(), op, state: 'pending' });
              env.log(`[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)} handed to the leader tab`);
              env.post({ type: 'tab_commit_requested', id });
            })
        )
        .catch((e: unknown) => {
          env.log(
            `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)}: the requester lock failed - nothing handed over: ${String(e)}`,
            'warn'
          );
          resolve({ status: 'refused', reason: 'failed' });
        });
    });
  };
}

/**
 * The LEADER half: runs the stored requests with the executors registered, one at a time.
 *
 * `drain` is coalescing: a drain asked while one runs runs once more after it, never alongside it.
 */
export function createDelegationServer(env: DelegationEnv) {
  const executors: Partial<DelegatedCommitExecutors> = {};
  let draining: Promise<void> | null = null;
  let again = false;

  function settle(record: DelegationRecord, outcome: DelegatedOutcome<DelegatedCommitKind>): void {
    writeRecord(env, { ...record, state: 'done', outcome });
    env.post({ type: 'tab_commit_settled', id: record.id });
  }

  async function runExecutor(
    op: DelegatedCommitOp
  ): Promise<DelegatedOutcome<DelegatedCommitKind>> {
    const execute = executors[op.kind] as
      | ((o: DelegatedCommitOp) => Promise<DelegatedCommitResults[DelegatedCommitKind]>)
      | undefined;
    if (!execute) return { status: 'refused', reason: 'failed' };
    try {
      return { status: 'done', value: await execute(op) };
    } catch (e) {
      // AN EXECUTOR ANSWERS BY VALUE: a throw reaching here is a gesture whose own classification
      // missed a case - said at error, and the follower is told it failed.
      console.error(`[TAB-COMMIT] ${describe(op)} threw in the leader tab:`, e);
      env.log(
        `[TAB-COMMIT] ${describe(op)} threw in the leader tab: ${String(e).slice(0, 160)}`,
        'warn'
      );
      return { status: 'refused', reason: 'failed' };
    }
  }

  /** A `done` record: answered again while its requester lives, deleted once it is gone. */
  async function answerOrForget(locks: DelegationLocks, record: DelegationRecord): Promise<void> {
    const requesterGone = await locks.request(
      `${REQUESTER_LOCK_PREFIX}${record.id}`,
      { ifAvailable: true },
      (lock) => lock !== null
    );
    if (requesterGone) {
      env.store.removeItem(recordKey(record.id));
      env.log(
        `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)}: its tab is gone - the answered record is removed`
      );
      return;
    }
    env.post({ type: 'tab_commit_settled', id: record.id });
  }

  async function serve(locks: DelegationLocks, key: string): Promise<void> {
    const record = readRecord(env, key);
    if (!record) return;
    if (record.state === 'done') {
      await answerOrForget(locks, record);
      return;
    }
    if (record.account !== env.account()) {
      env.log(
        `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)} asked by another account than this leader's - refused, not run`,
        'warn'
      );
      settle(record, { status: 'refused', reason: 'not-delegable' });
      return;
    }
    const verdict = await locks.request(
      `${RUN_LOCK_PREFIX}${record.id}`,
      { ifAvailable: true },
      async (lock): Promise<'busy' | 'settled' | 'abandoned' | 'no-executor' | 'served'> => {
        if (lock === null) return 'busy';
        // RE-READ UNDER THE LOCK: whatever was read before it may have been moved by its holder.
        const current = readRecord(env, key);
        if (!current || current.state === 'done') return 'settled';
        if (current.state === 'running') {
          // Claimed, unsettled, and its run lock free: the document that ran it is gone.
          env.log(
            `[TAB-COMMIT] ${current.id.slice(0, 8)}... ${describe(current.op)}: the leader that ran it is gone mid-request - answered leader-gone, NOT run again`,
            'warn'
          );
          settle(current, { status: 'refused', reason: 'leader-gone' });
          return 'abandoned';
        }
        if (!executors[current.op.kind]) return 'no-executor';
        writeRecord(env, { ...current, state: 'running' });
        env.log(
          `[TAB-COMMIT] ${current.id.slice(0, 8)}... ${describe(current.op)} run for a follower tab`
        );
        settle(current, await runExecutor(current.op));
        return 'served';
      }
    );
    if (verdict === 'no-executor') {
      env.log(
        `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)} waits: nothing here runs it yet`
      );
    }
    if (verdict === 'busy') {
      // Another document holds the run lock (a demoted leader still finishing it): drained again
      // the moment that document settles it or ends - the release is the signal, no clock.
      env.log(
        `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)} is being run elsewhere - drained again on its release`
      );
      void locks
        .request(`${RUN_LOCK_PREFIX}${record.id}`, {}, () => undefined)
        .then(() => drain('a run lock was released'))
        .catch((e: unknown) =>
          env.log(`[TAB-COMMIT] the wait on a run lock failed: ${String(e).slice(0, 120)}`, 'warn')
        );
    }
  }

  async function pass(): Promise<void> {
    const locks = env.locks;
    if (!locks || !env.isLeader() || !env.account()) return;
    for (const key of recordKeys(env)) {
      // Isolated per record: one that fails to be served must not strand the ones after it.
      try {
        await serve(locks, key);
      } catch (e) {
        env.log(`[TAB-COMMIT] ${key} could not be served: ${String(e).slice(0, 160)}`, 'warn');
      }
    }
  }

  /** Serves every stored request this leader can, now. Resolves when the drain it joined is over. */
  function drain(reason: string): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    env.log(`[TAB-COMMIT] drain (${reason})`);
    draining = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again);
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  /** Registers the executors a module owns; returns their removal. */
  function register(own: Partial<DelegatedCommitExecutors>): () => void {
    Object.assign(executors, own);
    void drain('executors registered');
    return () => {
      for (const kind of Object.keys(own) as DelegatedCommitKind[]) {
        if (executors[kind] === own[kind]) delete executors[kind];
      }
    };
  }

  /** Listens for the followers' signals; returns the unsubscription. */
  function listen(): () => void {
    return env.subscribe((event) => {
      if (event.type !== 'tab_commit_requested' || !env.isLeader()) return;
      void drain(`requested ${event.id.slice(0, 8)}...`);
    });
  }

  return { drain, register, listen };
}

// ── This document's wiring ───────────────────────────────────────────────────────────────────────

/**
 * Handlers in THIS document. A BroadcastChannel never delivers to the context that posted, so a
 * document that asked and was then promoted without a reload would never hear its own leader settle
 * its request: every signal is also handed to this document's own listeners.
 */
const localHandlers = new Set<(event: TabCommitEvent) => void>();

function productionEnv(): DelegationEnv {
  return {
    store: localStorage,
    locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
    post: (event) => {
      postTabCommitEvent(event);
      for (const handler of localHandlers) handler(event);
    },
    subscribe: (handler) => {
      localHandlers.add(handler);
      const unsubscribe = subscribeTabCommitEvents(handler);
      return () => {
        localHandlers.delete(handler);
        unsubscribe();
      };
    },
    account: () => currentUserId() ?? '',
    isLeader: getIsTabLeader,
    newId: () => crypto.randomUUID(),
    log: (message, level) => (level === 'warn' ? console.warn(message) : console.info(message)),
  };
}

let client: ReturnType<typeof createDelegationClient> | null = null;
let server: ReturnType<typeof createDelegationServer> | null = null;
let stopListening: (() => void) | null = null;

/**
 * From a FOLLOWER tab: hands `op` to the leader tab and resolves with its outcome - see the module
 * comment. Never rejects.
 */
export function delegateCommitToLeader<K extends DelegatedCommitKind>(
  op: Extract<DelegatedCommitOp, { kind: K }>
): Promise<DelegatedOutcome<K>> {
  client ??= createDelegationClient(productionEnv());
  return client(op);
}

/**
 * Registers the executors a module owns, so this tab runs a follower's request of that kind once it
 * leads. Returns their removal. The first registration starts listening for the followers' signals.
 */
export function serveDelegatedCommits(own: Partial<DelegatedCommitExecutors>): () => void {
  server ??= createDelegationServer(productionEnv());
  stopListening ??= server.listen();
  return server.register(own);
}

/**
 * Serves every stored request now - called when this tab's session is up as the leader, which is
 * also how a request left `pending` by a leader that closed is run by the one that follows it.
 */
export function drainDelegatedCommits(reason: string): Promise<void> {
  server ??= createDelegationServer(productionEnv());
  stopListening ??= server.listen();
  return server.drain(reason);
}
