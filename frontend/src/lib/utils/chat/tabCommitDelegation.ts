/**
 * A FOLLOWER TAB'S COMMIT, DONE BY THE LEADER (owner, 2026-11-08).
 *
 * Only the leader tab runs this device's MLS state (`tabLeader.ts`): a follower holds a copy loaded
 * once, which it cannot make durable and which the leader never learns from, so a commit is refused
 * in a follower at the service (`FollowerTabCommitError`). Until this module that refusal was what
 * the member met - creating a conversation, inviting, removing, entering a community's or a salon's
 * key group all said "do it from the other tab". Now the follower HANDS THE GESTURE to the leader,
 * which runs it on its authoritative state exactly as its own gesture, and answers the outcome.
 * A follower's application SENDS travel the same way (kind `send`, `tabSendDelegation.ts`).
 *
 * WHO SERVES: a document that leads AND loaded its MLS state as the leader
 * (`servesFollowerCommits`, `stateAuthority.ts`) runs a request; a leader whose login has not loaded
 * a state yet may only answer one (a refusal, a death - `answersFollowerCommits`). A follower
 * promoted in place is the leader from that instant, but its copy is a follower's until its
 * promotion reload: it runs and answers NOTHING, and its reloaded successor does both.
 *
 * THE SHAPE IS THE OUTBOX'S: the request is a DURABLE RECORD in the account's IndexedDB
 * (`tabCommitStore.ts`), committed before the signal is posted, and only a signal crosses
 * `canari-tab-messages`. A record is
 *
 *   pending  -- written by the follower, which holds the record's REQUESTER LOCK while it waits;
 *   running  -- claimed by a leader, which holds the record's RUN LOCK while it executes and writes
 *               `done` before releasing it;
 *   done     -- carries the outcome; the follower that asked deletes it when it reads it.
 *
 * Every move between states is a read-check-write in ONE IndexedDB transaction, taken under the run
 * lock: a `done` is never overwritten, a `pending` is claimed once.
 *
 * A LEADER THAT DIES MID-REQUEST IS PROVEN DEAD BY THE BROWSER, NOT A CLOCK. A record found
 * `running` whose run lock is FREE was claimed by a document that ended without settling it - the
 * browser releases a lock when its document goes (the `salonUnsent.ts` rule). It is answered
 * `leader-gone` and NEVER RUN AGAIN: the dead leader may have reached the server, and its
 * kept-commit machinery settles that at the next connection; a second run is the double commit.
 *
 * A REQUEST IS ALWAYS ANSWERED while its follower lives. The leader's readiness decides how
 * ({@link setDelegationReadiness}): `ready` (a live session) runs it; `unavailable` (the PIN gate, a
 * sign-out) answers `leader-unavailable` at once, nothing run - the member unlocks the main tab or
 * retries; `starting` (a login in progress) leaves it `pending` until the login ends in one of the
 * other two. A kind no executor here runs is answered `not-delegable`. A request whose follower is
 * gone (its requester lock free) is deleted and never run - the gesture is nobody's any more, and a
 * request of a session that signed out is gone with it ({@link abandonDelegatedCommits}).
 *
 * The refusals, all typed: `leader-gone`, `leader-unavailable`, `not-delegable` (no Web Locks in
 * this engine, or a leader signed in to ANOTHER account - the lock is per browser), `failed` (an
 * executor threw instead of answering, the visible end of a defect).
 */
import type { MemberRemovalOutcome } from '$lib/utils/chat/groupActions';
import type { BulkAdditionOutcome, ConversationOutcome } from '$lib/utils/chat/groupCreation';
import {
  postTabCommitEvent,
  subscribeTabCommitEvents,
  type TabCommitEvent,
} from '$lib/mls-client/tabMessageSync';
import { answersFollowerCommits, servesFollowerCommits } from '$lib/mls-client/stateAuthority';
import { currentUserId } from '$lib/stores/userState.svelte';
import {
  IdbTabCommitStore,
  isTabCommitAccountWiped,
  readmitTabCommitAccount,
  type TabCommitStore,
} from '$lib/utils/chat/tabCommitStore';

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
  | { kind: 'enter-salon-group'; workspaceId: string; channelId: string; isPrivate: boolean }
  /**
   * One application frame, sealed and posted by the leader (`tabSendDelegation.ts`). The plaintext
   * and its delivery are in `payload`, SEALED under the device key ({@link SealedTabPayload}).
   */
  | { kind: 'send'; groupId: string; payload?: SealedTabPayload }
  /** One MLS exporter secret of `groupId` at the leader's epoch (a call's media keys); sealed. */
  | { kind: 'export-secret'; groupId: string; payload?: SealedTabPayload }
  /** Whether the leader can carry a call's frames right now - asked before anything rings. */
  | { kind: 'call-preflight'; groupId: string };

/**
 * A request's or an answer's secret part, AES-256-GCM under the device key (`encryptData`, the
 * cipher every encrypted row of this device uses), base64 so a record stays plain data. It is
 * DROPPED from the record the moment a leader claims the request, and never written into an
 * answered one ({@link withoutPayload}): the store holds it only while it waits.
 */
export interface SealedTabPayload {
  iv: string;
  cipherText: string;
}

/**
 * The leader's own error, carried by CLASS as a closed set (never by its name or message, which
 * only the log reads): `transport` (the request never got an answer), `refused` (the server answered
 * a refusal), `commit-outcome-unknown` (a commit of the group is unresolved, nothing sealed),
 * `lead-lost` (the leader lost the lead itself), `unreadable` (the sealed payload did not open under
 * the leader's device key), `other` (a class no caller branches on).
 */
export type DelegatedErrorClass =
  | 'transport'
  | 'refused'
  | 'commit-outcome-unknown'
  | 'lead-lost'
  | 'unreadable'
  | 'other';

/** What the leader's send came to: the frame, or its own failure carried as data. */
export type DelegatedSendResult =
  | { status: 'sent'; sealed: string; authorProof: string; receivedAt: number | null }
  | { status: 'failed'; errorClass: DelegatedErrorClass; message: string };

/** What the leader's export came to: the secret, sealed like the request, or its failure. */
export type DelegatedExportResult =
  | { status: 'exported'; secret: SealedTabPayload }
  | { status: 'failed'; errorClass: DelegatedErrorClass; message: string };

/** The op as it may be kept in a record: without its sealed payload. */
export function withoutPayload(op: DelegatedCommitOp): DelegatedCommitOp {
  if (!('payload' in op)) return op;
  const { payload: _dropped, ...rest } = op;
  return rest as DelegatedCommitOp;
}

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
  send: DelegatedSendResult;
  'export-secret': DelegatedExportResult;
  'call-preflight': 'ready';
}

/** Why the leader did not answer the gesture itself (see the module comment). */
export type DelegationRefusal = 'leader-gone' | 'leader-unavailable' | 'not-delegable' | 'failed';

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
export interface DelegationRecord {
  id: string;
  /** The account of the follower that asked: the store is that account's. */
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

/** What the leader can do with a request right now - see the module comment. */
export type DelegationReadiness = 'starting' | 'ready' | 'unavailable';

/** Everything the mechanism touches, injected so two tabs can be simulated in one test. */
export interface DelegationEnv {
  /** The store of `account`'s requests. */
  storeFor(account: string): TabCommitStore<DelegationRecord>;
  /** Null where the engine has no Web Locks: nothing could prove a leader dead, so nothing is delegated. */
  locks: DelegationLocks | null;
  post(event: TabCommitEvent): void;
  subscribe(handler: (event: TabCommitEvent) => void): () => void;
  /** This tab's signed-in account, `''` when none. */
  account(): string;
  /** Whether this document RUNS a follower's commits: it leads, on a state it loaded as leader. */
  serves(): boolean;
  /**
   * Whether this document may ANSWER a request without running it (a refusal, a death): it leads and
   * its copy is not a follower's. A follower promoted in place answers nothing - its reloaded
   * successor does.
   */
  answers(): boolean;
  /**
   * Whether `account`'s data was wiped in this document (and it is not signed in here again): its
   * store is dropped and never opened, so a drain cannot re-create the database the wipe deleted.
   */
  wiped(account: string): boolean;
  readiness(): DelegationReadiness;
  newId(): string;
  /** `warn` for a line that ACCUSES (a refusal, a death), `error` for a defect; info otherwise. */
  log(message: string, level?: 'warn' | 'error'): void;
}

const RUN_LOCK_PREFIX = 'canari.tab-commit.run.';
const REQUESTER_LOCK_PREFIX = 'canari.tab-commit.requester.';

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
    case 'send':
      return `send to ${op.groupId.slice(0, 8)}...`;
    case 'export-secret':
      return `exporter secret of ${op.groupId.slice(0, 8)}...`;
    case 'call-preflight':
      return `call preflight in ${op.groupId.slice(0, 8)}...`;
  }
}

/** Whether nobody holds `name` - taken and released at once when free. */
function lockIsFree(locks: DelegationLocks, name: string): Promise<boolean> {
  return locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
}

/** A request this document is waiting on. */
interface InFlight {
  account: string;
  op: DelegatedCommitOp;
  finish(outcome: DelegatedOutcome<DelegatedCommitKind>, keepRecord?: boolean): void;
}

/**
 * The FOLLOWER half: hands `op` to the leader and resolves with its outcome. It never rejects - every
 * ending is an answer: done, or a typed refusal.
 */
export function createDelegationClient(env: DelegationEnv) {
  const inFlight = new Map<string, InFlight>();

  function delegate<K extends DelegatedCommitKind>(
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
    const account = env.account();
    if (!account) {
      env.log(`[TAB-COMMIT] ${describe(op)} not delegated: this tab is signed out`, 'warn');
      return Promise.resolve({ status: 'refused', reason: 'leader-unavailable' });
    }
    const store = env.storeFor(account);
    const id = env.newId();
    return new Promise<DelegatedOutcome<K>>((resolve) => {
      // THE REQUESTER LOCK IS TAKEN BEFORE THE RECORD EXISTS, so no drain can ever see the record
      // with the lock free while this document is alive and waiting.
      locks
        .request(
          `${REQUESTER_LOCK_PREFIX}${id}`,
          {},
          () =>
            new Promise<void>((release) => {
              let finished = false;
              let unsubscribe = () => {};
              const finish = (
                outcome: DelegatedOutcome<DelegatedCommitKind>,
                keepRecord = false
              ) => {
                if (finished) return;
                finished = true;
                inFlight.delete(id);
                unsubscribe();
                const removal = keepRecord ? Promise.resolve() : store.delete(id);
                void removal
                  .catch((e: unknown) =>
                    env.log(
                      `[TAB-COMMIT] ${id.slice(0, 8)}... its answered record could not be deleted - the leader's next drain removes it: ${String(e)}`,
                      'warn'
                    )
                  )
                  .finally(release);
                env.log(
                  `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)} answered: ${outcome.status === 'done' ? 'done' : outcome.reason}`,
                  outcome.status === 'done' ? undefined : 'warn'
                );
                resolve(outcome as DelegatedOutcome<K>);
              };
              const check = () => {
                void store
                  .get(id)
                  .then((record) => {
                    if (finished) return;
                    if (record === null) {
                      // Only this document deletes a record whose requester lives: a wipe did.
                      env.log(
                        `[TAB-COMMIT] ${id.slice(0, 8)}... the record vanished while waiting`,
                        'warn'
                      );
                      finish({ status: 'refused', reason: 'failed' }, true);
                      return;
                    }
                    if (record.state === 'done' && record.outcome) finish(record.outcome);
                  })
                  .catch((e: unknown) =>
                    env.log(
                      `[TAB-COMMIT] ${id.slice(0, 8)}... the record could not be read: ${String(e)}`,
                      'warn'
                    )
                  );
              };
              inFlight.set(id, { account, op, finish });
              unsubscribe = env.subscribe((event) => {
                if (event.type === 'tab_commit_settled' && event.id === id) check();
              });
              // THE SIGNAL LEAVES ONLY ONCE THE RECORD IS COMMITTED: whoever hears it can read it.
              store
                .put({ id, account, op, state: 'pending' })
                .then(() => {
                  env.log(
                    `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)} handed to the leader tab`
                  );
                  env.post({ type: 'tab_commit_requested', id, account });
                })
                .catch((e: unknown) => {
                  env.log(
                    `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(op)} could not be stored - nothing handed over: ${String(e)}`,
                    'warn'
                  );
                  finish({ status: 'refused', reason: 'failed' }, true);
                });
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
  }

  /**
   * The session that asked is over (a sign-out): every wait ends `leader-unavailable` and its record
   * is deleted, so nothing of it is run for the next session - of this account or another.
   */
  function abandon(reason: string): number {
    const pending = [...inFlight.values()];
    for (const request of pending) {
      env.log(`[TAB-COMMIT] ${describe(request.op)} abandoned: ${reason}`, 'warn');
      request.finish({ status: 'refused', reason: 'leader-unavailable' });
    }
    return pending.length;
  }

  return { delegate, abandon };
}

/**
 * The LEADER half: answers the stored requests with the executors registered, one at a time.
 *
 * `drain` is coalescing: a drain asked while one runs runs once more after it, never alongside it.
 */
export function createDelegationServer(env: DelegationEnv) {
  const executors: Partial<DelegatedCommitExecutors> = {};
  let draining: Promise<void> | null = null;
  let again = false;

  /**
   * Writes `outcome` into a record still in state `from`, in one transaction, and signals it. A
   * record in any other state is left alone: a `done` is never overwritten.
   */
  async function settle(
    store: TabCommitStore<DelegationRecord>,
    record: DelegationRecord,
    from: 'pending' | 'running',
    outcome: DelegatedOutcome<DelegatedCommitKind>
  ): Promise<void> {
    // An answered record never keeps a sealed payload - a refusal of a still-pending one included.
    const after = await store.update(record.id, (current) =>
      current?.state === from
        ? { ...current, op: withoutPayload(current.op), state: 'done', outcome }
        : null
    );
    if (after?.state === 'done') {
      env.post({ type: 'tab_commit_settled', id: record.id, account: record.account });
    }
  }

  async function runExecutor(
    op: DelegatedCommitOp
  ): Promise<DelegatedOutcome<DelegatedCommitKind>> {
    const execute = executors[op.kind] as
      | ((o: DelegatedCommitOp) => Promise<DelegatedCommitResults[DelegatedCommitKind]>)
      | undefined;
    if (!execute) return { status: 'refused', reason: 'not-delegable' };
    try {
      return { status: 'done', value: await execute(op) };
    } catch (e) {
      // AN EXECUTOR ANSWERS BY VALUE: a throw reaching here is a gesture whose own classification
      // missed a case - said once, at error, and the follower is told it failed.
      env.log(
        `[TAB-COMMIT] ${describe(op)} threw in the leader tab: ${String(e).slice(0, 200)}`,
        'error'
      );
      return { status: 'refused', reason: 'failed' };
    }
  }

  /** A `done` record: signalled again while its requester lives, deleted once it is gone. */
  async function answerOrForget(
    locks: DelegationLocks,
    store: TabCommitStore<DelegationRecord>,
    record: DelegationRecord
  ): Promise<void> {
    if (await lockIsFree(locks, `${REQUESTER_LOCK_PREFIX}${record.id}`)) {
      await store.delete(record.id);
      env.log(
        `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)}: its tab is gone - the answered record is removed`
      );
      return;
    }
    env.post({ type: 'tab_commit_settled', id: record.id, account: record.account });
  }

  type Verdict = 'busy' | 'settled' | 'waits' | 'answered' | 'orphan' | 'served';

  /** Decides one unanswered record, UNDER ITS RUN LOCK - everything it reads, it reads there. */
  async function decide(
    locks: DelegationLocks,
    store: TabCommitStore<DelegationRecord>,
    id: string
  ): Promise<Verdict> {
    return locks.request(`${RUN_LOCK_PREFIX}${id}`, { ifAvailable: true }, async (lock) => {
      if (lock === null) return 'busy';
      const current = await store.get(id);
      if (!current || current.state === 'done') return 'settled';
      const tag = `[TAB-COMMIT] ${id.slice(0, 8)}... ${describe(current.op)}`;
      if (current.state === 'running') {
        // Claimed, unsettled, and its run lock free: the document that ran it is gone.
        env.log(
          `${tag}: the leader that ran it is gone mid-request - leader-gone, NOT run again`,
          'warn'
        );
        await settle(store, current, 'running', { status: 'refused', reason: 'leader-gone' });
        return 'answered';
      }
      if (await lockIsFree(locks, `${REQUESTER_LOCK_PREFIX}${id}`)) {
        // Nobody waits for it any more (a closed tab, a sign-out): the gesture is nobody's.
        await store.update(id, (r) => (r?.state === 'pending' ? 'delete' : null));
        env.log(`${tag}: the tab that asked is gone - removed, NOT run`, 'warn');
        return 'orphan';
      }
      const account = env.account();
      if (current.account !== account) {
        // The lock is per browser, the session per account: this leader's state is not the asker's.
        const reason = account ? 'not-delegable' : 'leader-unavailable';
        env.log(
          `${tag}: asked by another account than this leader's (${account ? 'signed in elsewhere' : 'signed out'}) - ${reason}, not run`,
          'warn'
        );
        await settle(store, current, 'pending', { status: 'refused', reason });
        return 'answered';
      }
      const readiness = env.readiness();
      if (readiness === 'starting') {
        env.log(`${tag} waits: this leader's session is still starting`);
        return 'waits';
      }
      if (readiness === 'unavailable') {
        env.log(
          `${tag}: this leader has no session (locked or signed out) - leader-unavailable`,
          'warn'
        );
        await settle(store, current, 'pending', {
          status: 'refused',
          reason: 'leader-unavailable',
        });
        return 'answered';
      }
      if (!env.serves()) {
        // Ready, but on a copy this document did not load as the leader: never run here.
        env.log(`${tag} waits: this tab's state was not loaded as the leader's`, 'warn');
        return 'waits';
      }
      if (!executors[current.op.kind]) {
        env.log(`${tag}: nothing in this leader runs it - not-delegable`, 'warn');
        await settle(store, current, 'pending', { status: 'refused', reason: 'not-delegable' });
        return 'answered';
      }
      // THE CLAIM DROPS THE SEALED PAYLOAD from the record, in the same transaction: from here it
      // lives only in this document's memory, for the run.
      let toRun = null as DelegatedCommitOp | null;
      const claimed = await store.update(id, (r) => {
        if (r?.state !== 'pending') return null;
        toRun = r.op;
        return { ...r, op: withoutPayload(r.op), state: 'running' };
      });
      if (claimed?.state !== 'running' || toRun === null) return 'settled';
      const op: DelegatedCommitOp = toRun;
      // RE-READ AFTER THE CLAIM'S AWAIT, right before the run: a sign-out (or a demotion) landing
      // between the decision and here must not run the gesture against a session that is ending -
      // an executor reaching for MLS then would build a client for nobody.
      if (env.readiness() !== 'ready' || !env.serves() || env.account() !== claimed.account) {
        env.log(
          `${tag}: this leader's session ended before the run - leader-unavailable, not run`,
          'warn'
        );
        await settle(store, claimed, 'running', {
          status: 'refused',
          reason: 'leader-unavailable',
        });
        return 'answered';
      }
      env.log(`${tag} run for a follower tab`);
      await settle(store, claimed, 'running', await runExecutor(op));
      return 'served';
    });
  }

  async function serve(
    locks: DelegationLocks,
    store: TabCommitStore<DelegationRecord>,
    record: DelegationRecord
  ): Promise<void> {
    if (record.state === 'done') {
      await answerOrForget(locks, store, record);
      return;
    }
    const verdict = await decide(locks, store, record.id);
    if (verdict === 'busy') {
      // Another document holds the run lock (a demoted leader still finishing it): drained again the
      // moment that document settles it or ends - the release is the signal, no clock.
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

  /** The accounts whose requests this document has heard of, its own included. */
  const accounts = new Set<string>();

  async function pass(): Promise<void> {
    const locks = env.locks;
    if (!locks || !env.answers()) return;
    const own = env.account();
    if (own) accounts.add(own);
    for (const account of accounts) {
      if (env.wiped(account)) {
        accounts.delete(account);
        env.log(
          `[TAB-COMMIT] ${account.slice(0, 8)}...'s data was wiped - its requests are no longer read`
        );
        continue;
      }
      const store = env.storeFor(account);
      let records: DelegationRecord[];
      try {
        records = await store.list();
      } catch (e) {
        // Isolated per account: one store that cannot be read must not strand the others.
        env.log(
          `[TAB-COMMIT] the requests of ${account.slice(0, 8)}... could not be read: ${String(e)}`,
          'warn'
        );
        continue;
      }
      for (const record of records) {
        // Isolated per record: one that fails to be served must not strand the ones after it.
        try {
          await serve(locks, store, record);
        } catch (e) {
          env.log(
            `[TAB-COMMIT] ${record.id.slice(0, 8)}... could not be served: ${String(e)}`,
            'warn'
          );
        }
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
      if (event.type !== 'tab_commit_requested') return;
      // Remembered even when this document does not answer yet: its drain at promotion reads it.
      accounts.add(event.account);
      if (env.answers()) void drain(`requested ${event.id.slice(0, 8)}...`);
    });
  }

  return { drain, register, listen };
}

// ── This document's wiring ───────────────────────────────────────────────────────────────────────

/**
 * Handlers in THIS document. A BroadcastChannel never delivers to the context that posted, so every
 * signal is also handed to this document's own listeners.
 */
const localHandlers = new Set<(event: TabCommitEvent) => void>();
const stores = new Map<string, IdbTabCommitStore<DelegationRecord>>();
let readiness: DelegationReadiness = 'starting';

function productionEnv(): DelegationEnv {
  return {
    storeFor: (account) => {
      // Signed in here again after a wipe (a revoked device's account still exists): readmitted.
      if (account === currentUserId()) readmitTabCommitAccount(account);
      let store = stores.get(account);
      if (!store) {
        store = new IdbTabCommitStore<DelegationRecord>(account);
        stores.set(account, store);
      }
      return store;
    },
    wiped: (account) => {
      if (account === currentUserId() || !isTabCommitAccountWiped(account)) return false;
      stores.delete(account);
      return true;
    },
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
    serves: servesFollowerCommits,
    answers: answersFollowerCommits,
    readiness: () => readiness,
    newId: () => crypto.randomUUID(),
    log: (message, level) =>
      level === 'error'
        ? console.error(message)
        : level === 'warn'
          ? console.warn(message)
          : console.info(message),
  };
}

let client: ReturnType<typeof createDelegationClient> | null = null;
let server: ReturnType<typeof createDelegationServer> | null = null;
let stopListening: (() => void) | null = null;

function ensureServer(): ReturnType<typeof createDelegationServer> {
  server ??= createDelegationServer(productionEnv());
  stopListening ??= server.listen();
  return server;
}

/**
 * From a FOLLOWER tab: hands `op` to the leader tab and resolves with its outcome - see the module
 * comment. Never rejects.
 */
export function delegateCommitToLeader<K extends DelegatedCommitKind>(
  op: Extract<DelegatedCommitOp, { kind: K }>
): Promise<DelegatedOutcome<K>> {
  client ??= createDelegationClient(productionEnv());
  return client.delegate(op);
}

/**
 * Registers the executors a module owns, so this tab runs a follower's request of that kind when it
 * serves. Returns their removal. The first registration starts listening for the followers' signals.
 */
export function serveDelegatedCommits(own: Partial<DelegatedCommitExecutors>): () => void {
  return ensureServer().register(own);
}

/**
 * The readiness a session's two flags mean: a live session runs a request, a login RUNNING keeps it
 * waiting, anything else (the PIN keypad up, nobody signed in) answers it at once.
 */
export function sessionDelegationReadiness(
  isLoggedIn: boolean,
  isLoginInProgress: boolean
): DelegationReadiness {
  return isLoggedIn ? 'ready' : isLoginInProgress ? 'starting' : 'unavailable';
}

/**
 * What this tab's session can do with a follower's request, set by the ONE writer of the session's
 * flags (`useChatSession`: `setIsLoggedIn`, `setIsLoginInProgress`) through
 * {@link sessionDelegationReadiness}: leaving `starting` drains, so every request waiting on the
 * login is answered.
 */
export function setDelegationReadiness(next: DelegationReadiness): void {
  if (readiness === next) return;
  readiness = next;
  if (next !== 'starting') void ensureServer().drain(`this tab is ${next}`);
}

/** The session signed out: this tab's own requests end, and the leader answers no request until the next one. */
export function abandonDelegatedCommits(reason: string): number {
  setDelegationReadiness('unavailable');
  return client?.abandon(reason) ?? 0;
}
