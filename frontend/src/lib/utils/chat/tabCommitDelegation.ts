/**
 * A FOLLOWER TAB'S COMMIT, DONE BY THE LEADER (owner, 2026-11-08).
 *
 * Only the leader tab runs this device's MLS state (`tabLeader.ts`): a follower holds a copy loaded
 * once, which it cannot make durable and which the leader never learns from, so a commit is refused
 * in a follower at the service (`FollowerTabCommitError`). Until this module that refusal was what
 * the member met - creating a conversation, inviting, removing, entering a community's or a salon's
 * key group all said "do it from the other tab". Now the follower HANDS THE GESTURE to the leader,
 * which runs it on its authoritative state exactly as its own gesture, and answers the outcome.
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
 * ({@link setDelegationReadiness}): `ready` (a live session) runs it; `starting` (a login in progress)
 * leaves it `pending` until the login ends; `unavailable` (the PIN gate, a sign-out) leaves it
 * `pending` too, because a leader whose session ended GIVES THE LEAD UP once its last MLS work settles
 * (`setTabLeadEligibility`, `leadHolds.ts`, 2026-11-24) and the tab that takes the lead runs it; a
 * claim made before the session ended is handed back to `pending`. A kind no executor here runs is
 * answered `not-delegable`. A request whose follower is gone (its requester lock free) is deleted and
 * never run - the gesture is nobody's any more, and a request of a session that signed out is gone
 * with it ({@link abandonDelegatedCommits}) - unless its requester is THIS tab before its promotion
 * reload, which adopts it ({@link carryTabCommitRequesterAcrossReload}).
 *
 * The refusals, all typed: `leader-gone`, `leader-unavailable`, `not-delegable` (no Web Locks in
 * this engine, or a leader signed in to ANOTHER account - the lock is per browser), `failed` (an
 * executor threw instead of answering, the visible end of a defect).
 *
 * ONE TAB'S REQUESTS RUN IN THE ORDER IT MADE THEM (review of #3371): a record carries an order key
 * that only grows in its tab and the tab it came from; the follower writes its records one after
 * another, and the drain sorts on the key and holds a tab's later records back while an earlier one
 * waits. A call's hangup never overtakes its invitation; two salon messages typed quickly keep their
 * order.
 */
import type { MemberRemovalOutcome } from '$lib/utils/chat/groupActions';
import type { SealedChannelMessage } from '$lib/utils/graine/channelSeal';
import type { GraineSealUnavailableReason } from '$lib/utils/graine/sealUnavailable';
import type { SalonGateRefusal } from '$lib/utils/graine/salonSendGate';
import type { AskReason } from '$lib/utils/graine/repair';
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
  /** "Mes notes", this account's conversation with itself (`createSelfConversation`). */
  | { kind: 'create-self' }
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
   * One MLS application frame, sent by the leader (`mls-client/frameFromAnyTab.ts`). The frame's
   * plaintext is SEALED under the device key in the record ({@link HandedOverBytes}): a record is
   * IndexedDB, and nothing a member wrote rests there in clear.
   */
  | {
      kind: 'emit-frame';
      groupId: string;
      frame: HandedOverBytes;
      messageId?: string;
      delivery: HandedFrameDelivery;
    }
  /**
   * One salon message, SEALED by the leader under its Graine session (`channelSeal.ts`): only the
   * leader reserves an outbound index, mints or distributes a seed, and writes the Graine store. The
   * payload rests sealed under the device key, like a frame's.
   */
  | { kind: 'seal-salon-message'; channelId: string; payload: HandedOverBytes }
  /**
   * The Graine seeds of one channel a follower could not open rows for, asked for by the leader
   * (`repair.ts`): one record per channel for every seed named while the previous one was in flight.
   */
  | {
      kind: 'note-missing-seeds';
      channelId: string;
      seeds: Array<{ sessionId: string; senderId: string; sentAt?: number; reason: AskReason }>;
    };

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
interface DelegatedCommitResults {
  'create-group': ConversationOutcome;
  'create-self': ConversationOutcome;
  'start-direct': ConversationOutcome;
  invite: BulkAdditionOutcome;
  remove: DelegatedRemovalResult;
  'enter-community-key-group': 'entered';
  'enter-salon-group': 'entered';
  /**
   * The server's acceptance time of the frame, `null` when it answered none (`SentFrame`) - or, as
   * an answer and not a failure, `unopened`: the device key changed between the follower's seal and
   * the leader's open, nothing was sent; or `unsent`: the lead left the leader while it ran the
   * request, nothing was posted.
   */
  'emit-frame':
    | { receivedAt: number | null }
    | { unopened: HandoverUnopened }
    | { unsent: HandoverUnsent };
  /**
   * The sealed message; the typed reason the leader could not seal for that salon; the reason the
   * leader's OWN salon gate refused it (`whenSalonSendable`, waited on before the seal exactly as a
   * single tab waits); or `unopened` and `unsent`, as for a frame.
   */
  'seal-salon-message':
    | { sealed: SealedChannelMessage }
    | { unavailable: GraineSealUnavailableReason }
    | { gate: SalonGateRefusal }
    | { unopened: HandoverUnopened }
    | { unsent: HandoverUnsent };
  'note-missing-seeds': 'noted';
}

/** Why the leader could not open what a follower sealed: the device key changed in between. */
export type HandoverUnopened = 'device-key-changed';

/**
 * Why the leader that ran a follower's frame did not post it: the lead left it during the run (a
 * freeze, a handover) - an expected event, answered by value rather than thrown as a defect.
 */
export type HandoverUnsent = 'lead-lost';

/**
 * Bytes a follower hands to the leader, sealed under the account's device key (`encryption.ts`
 * `sealBytes`), base64 so a structured clone and JSON both carry them.
 */
export interface HandedOverBytes {
  iv: string;
  cipherText: string;
}

/**
 * The delivery class of a handed frame, BY NAME: a `FrameDelivery` is compared by identity
 * (`DELIVERY.visible`), which a record cannot carry, and an addressed delivery is never handed.
 */
export type HandedFrameDelivery = 'visible' | 'mutation' | 'transport';

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
  /**
   * Where the request stands among the others: a key that only grows in the tab that wrote it
   * ({@link createOrderKeys}). The drain runs the records in this order, never in the store's key
   * order - an id is random. Absent from a record written before 2026-11-11: read as the first.
   */
  order?: string;
  /**
   * The document that asked ({@link DelegationEnv.documentId}): its records run one after another,
   * and a later one never overtakes an earlier one still waiting. Absent before 2026-11-11: the
   * record is its own requester.
   */
  requester?: string;
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
  /** The next order key of this document ({@link createOrderKeys}). */
  orderKey(): string;
  /** This document's identity, the same for every request it makes. */
  documentId(): string;
  /**
   * Whether `requester` is THIS tab before its promotion reload ({@link carryTabCommitRequesterAcrossReload}):
   * its requests outlived the page that made them, and this page - the same tab, now the leader -
   * adopts them instead of deleting them as a closed tab's.
   */
  adopts(requester: string | undefined): boolean;
  /** `warn` for a line that ACCUSES (a refusal, a death), `error` for a defect; info otherwise. */
  log(message: string, level?: 'warn' | 'error'): void;
}

/**
 * What a tab does with a request it made before its promotion reload (second review of #4053):
 * - `run`: a gesture whose effect IS its outcome - a conversation, a membership, a key group, a frame
 *   the member sent (a forward, an invitation, a notice, an edit or a reaction): none of their callers
 *   keeps a durable queue, so dropped, the gesture was lost (charter principle 2). What the asking
 *   page would have done with the answer - a forward's own echo, a `receivedAt` - is said not done;
 * - `drop`: a call's transport frame, whose call ended with the page that held it, and a salon
 *   message's seal, whose sender queue (`useMessaging`'s salon queue) sends it again under the same
 *   client id once this page is live.
 */
function onAdoption(op: DelegatedCommitOp): 'run' | 'drop' {
  if (op.kind === 'emit-frame') return op.delivery === 'transport' ? 'drop' : 'run';
  return ADOPTABLE_KINDS.has(op.kind) ? 'run' : 'drop';
}

/** The kinds run on adoption without condition - see {@link onAdoption}. */
const ADOPTABLE_KINDS: ReadonlySet<DelegatedCommitKind> = new Set<DelegatedCommitKind>([
  'create-group',
  'create-self',
  'start-direct',
  'invite',
  'remove',
  'enter-community-key-group',
  'enter-salon-group',
  'note-missing-seeds',
]);

const RUN_LOCK_PREFIX = 'canari.tab-commit.run.';
const REQUESTER_LOCK_PREFIX = 'canari.tab-commit.requester.';

function describe(op: DelegatedCommitOp): string {
  switch (op.kind) {
    case 'create-group':
      return 'create-group';
    case 'create-self':
      return 'create-self';
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
    case 'emit-frame':
      return `frame in ${op.groupId.slice(0, 8)}... (${op.delivery})`;
    case 'seal-salon-message':
      return `salon message for ${op.channelId.slice(0, 8)}...`;
    case 'note-missing-seeds':
      return `${op.seeds.length} missing seed(s) of ${op.channelId.slice(0, 8)}...`;
  }
}

/**
 * A source of order keys that ONLY GROW in one document: the time, never allowed to go back (a clock
 * set back reuses the last value), then a counter for the requests made in the same millisecond.
 * Fixed width, so they compare as strings. Between two documents the time orders them; one document
 * never sees its own requests reordered.
 */
export function createOrderKeys(now: () => number): () => string {
  let lastTime = -1;
  let counter = 0;
  return () => {
    const time = Math.max(Math.floor(now()), lastTime);
    counter = time === lastTime ? counter + 1 : 0;
    lastTime = time;
    return `${time.toString().padStart(16, '0')}.${counter.toString().padStart(9, '0')}`;
  };
}

/** The order the drain runs records in: their order key, the id breaking a tie between two documents. */
function byOrder(a: DelegationRecord, b: DelegationRecord): number {
  const left = a.order ?? '';
  const right = b.order ?? '';
  if (left !== right) return left < right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  /**
   * THE RECORDS ARE WRITTEN IN THE ORDER THE GESTURES WERE MADE: each put waits for the previous
   * one to be committed (or to have failed), so no drain can ever see a later request of this
   * document without the earlier one - a hangup is never stored before its invitation.
   */
  let lastStored: Promise<void> = Promise.resolve();

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
    // Both taken NOW, in the caller's order, before any await.
    const order = env.orderKey();
    const prior = lastStored;
    let stored: () => void = () => {};
    lastStored = new Promise<void>((done) => (stored = done));
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
              void prior
                .then(() =>
                  store.put({
                    id,
                    account,
                    op,
                    state: 'pending',
                    order,
                    requester: env.documentId(),
                  })
                )
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
                })
                .finally(stored);
            })
        )
        .catch((e: unknown) => {
          stored();
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
    const after = await store.update(record.id, (current) =>
      current?.state === from ? { ...current, state: 'done', outcome } : null
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
      // NO LEAD HOLD AROUND THE EXECUTOR (second review of #4053): what it changes in the MLS state
      // holds the lead where it changes it - the MLS mutex, an external join, a mint - so a wait of
      // the gesture outside those (a salon's send gate) never keeps an ended session in the lead.
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
      if (!env.answers()) {
        // THIS DOCUMENT GAVE THE LEAD UP DURING THE PASS (its session can no longer serve, a
        // freeze): the record is the next leader's to decide, never answered by a tab that left.
        env.log(`${tag} waits: this tab no longer leads - left to the tab that took the lead`);
        return 'waits';
      }
      if (current.state === 'running') {
        // Claimed, unsettled, and its run lock free: the document that ran it is gone.
        env.log(
          `${tag}: the leader that ran it is gone mid-request - leader-gone, NOT run again`,
          'warn'
        );
        await settle(store, current, 'running', { status: 'refused', reason: 'leader-gone' });
        return 'answered';
      }
      let adopted = false;
      if (await lockIsFree(locks, `${REQUESTER_LOCK_PREFIX}${id}`)) {
        if (!env.adopts(current.requester)) {
          // Nobody waits for it any more (a closed tab, a sign-out): the gesture is nobody's.
          await store.update(id, (r) => (r?.state === 'pending' ? 'delete' : null));
          env.log(`${tag}: the tab that asked is gone - removed, NOT run`, 'warn');
          return 'orphan';
        }
        if (onAdoption(current.op) === 'drop') {
          // A call's frame or a salon seal: see `onAdoption` for why each is not run here.
          await store.update(id, (r) => (r?.state === 'pending' ? 'delete' : null));
          env.log(
            `${tag}: asked by this tab before its promotion reload - ${current.op.kind === 'emit-frame' ? 'its call ended with that page' : 'its sender queue sends it again'}, removed, not run`
          );
          return 'orphan';
        }
        // THIS TAB ASKED IT BEFORE ITS PROMOTION RELOAD (review of #4053): the asker was the tab the
        // lead went to, and the reload that promotion owes freed its requester lock. Deleted as a
        // closed tab's, the member's gesture vanished; this page is that tab, now able to run it.
        adopted = true;
        env.log(`${tag}: asked by this tab before its promotion reload - adopted and run here`);
      }
      if (env.readiness() === 'unavailable') {
        // A LEADER WHOSE SESSION ENDED STILL LEADS ONLY WHILE ITS LAST MLS WORK SETTLES
        // (`leadHolds.ts`), and gives the lead up then: the request is the next leader's to run,
        // never answered `leader-unavailable` by a tab on its way out.
        env.log(`${tag} waits: this leader's session ended - left to the tab that takes the lead`);
        return 'waits';
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
      if (env.readiness() === 'starting') {
        env.log(`${tag} waits: this leader's session is still starting`);
        return 'waits';
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
      const claimed = await store.update(id, (r) =>
        r?.state === 'pending' ? { ...r, state: 'running' } : null
      );
      if (claimed?.state !== 'running') return 'settled';
      // RE-READ AFTER THE CLAIM'S AWAIT, right before the run: a sign-out (or a demotion) landing
      // between the decision and here must not run the gesture against a session that is ending -
      // an executor reaching for MLS then would build a client for nobody.
      const stillReady = env.readiness() === 'ready';
      if (!env.answers() || !stillReady || !env.serves()) {
        // The session ended, or the lead left this document, during the claim: nothing ran, so the
        // claim is undone - still under the run lock - and the tab that takes the lead runs it. A
        // `leader-unavailable` here would dead-end a gesture a leader can serve. The designed
        // path, so said as narration, not accused.
        await store.update(id, (r) => (r?.state === 'running' ? { ...r, state: 'pending' } : null));
        env.log(
          `${tag}: this tab's session ended or its lead left before the run - handed back as pending for the tab that takes the lead, not run`
        );
        return 'waits';
      }
      if (env.account() !== claimed.account) {
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
      await settle(store, claimed, 'running', await runExecutor(claimed.op));
      if (adopted) {
        // Nobody reads this answer (the page that asked was reloaded): its effect is the answer.
        await store.update(id, (r) => (r?.state === 'done' ? 'delete' : null));
        if (claimed.op.kind === 'emit-frame') {
          // SAID, because it is a real gap: the frame reached its group, but what the asking page
          // did with the answer (a forward's own echo, the time the server took it) died with it.
          env.log(
            `${tag}: adopted frame sent - the page that asked was reloaded, so its own record of the send is not written`,
            'warn'
          );
        } else {
          env.log(`${tag}: adopted request settled - its record removed`);
        }
      }
      return 'served';
    });
  }

  async function serve(
    locks: DelegationLocks,
    store: TabCommitStore<DelegationRecord>,
    record: DelegationRecord
  ): Promise<Verdict> {
    if (record.state === 'done') {
      await answerOrForget(locks, store, record);
      return 'settled';
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
    return verdict;
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
      // ONE DOCUMENT'S REQUESTS RUN IN THE ORDER IT MADE THEM, one at a time: sorted on the order
      // key, and a request still waiting (its run lock held elsewhere, this leader not ready) holds
      // back every LATER request of the same document until a drain finds it settled - a hangup
      // never overtakes its invitation, a salon message never overtakes the one typed before it.
      records.sort(byOrder);
      const heldBack = new Set<string>();
      for (const record of records) {
        const requester = record.requester ?? record.id;
        if (record.state !== 'done' && heldBack.has(requester)) {
          env.log(
            `[TAB-COMMIT] ${record.id.slice(0, 8)}... ${describe(record.op)} waits: an earlier request of the same tab is not settled yet`
          );
          continue;
        }
        // Isolated per document: a record that fails to be served holds back the later records of
        // its own document, never another document's.
        try {
          const verdict = await serve(locks, store, record);
          if (verdict === 'busy' || verdict === 'waits') heldBack.add(requester);
        } catch (e) {
          heldBack.add(requester);
          env.log(
            `[TAB-COMMIT] ${record.id.slice(0, 8)}... could not be served - the later requests of its tab wait for the next drain: ${String(e)}`,
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
const nextOrderKey = createOrderKeys(() => Date.now());
/**
 * The identity this TAB carried across its promotion reload, read and removed SYNCHRONOUSLY at module
 * load, before anything of this page can await - the earliest point this module runs.
 *
 * BOUND TO THE RELOAD (second review of #4053): a tab duplicated in the window between the carry and
 * the reload copies `sessionStorage`, key included, and would adopt the same requests. So the id is
 * honoured only by a page whose own navigation IS a reload (`PerformanceNavigationTiming.type`), a
 * fact of this page the copy cannot share - a duplicated tab's first page is a navigation.
 */
const CARRIED_REQUESTER_KEY = 'canari_tab_commit_requester';
const carriedRequester: string | null = (() => {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const carried = sessionStorage.getItem(CARRIED_REQUESTER_KEY);
    sessionStorage.removeItem(CARRIED_REQUESTER_KEY);
    if (carried === null) return null;
    const [navigation] = performance.getEntriesByType(
      'navigation'
    ) as PerformanceNavigationTiming[];
    if (navigation?.type !== 'reload') {
      console.warn(
        `[TAB-COMMIT] a carried requester id reached a page that is not a reload (${navigation?.type ?? 'unknown'}) - a duplicated tab, not adopted`
      );
      return null;
    }
    return carried;
  } catch {
    return null;
  }
})();
/** @internal The requester id this page adopts, if its load carried one - for tests. */
export function carriedTabCommitRequester(): string | null {
  return carriedRequester;
}

/** Made at the first request, or carried from before a promotion reload. */
let thisDocument: string | null = carriedRequester;
function documentId(): string {
  thisDocument ??= crypto.randomUUID();
  return thisDocument;
}

/**
 * Called right before a PROMOTION reload (`useChatSession.reloadForPromotion`): this tab's requester
 * identity survives the reload, so the page it starts - the leader now - adopts the requests this
 * tab made as a follower instead of deleting them as a closed tab's (review of #4053). A tab that
 * made no request carries nothing.
 */
export function carryTabCommitRequesterAcrossReload(): void {
  if (thisDocument === null) return;
  try {
    sessionStorage.setItem(CARRIED_REQUESTER_KEY, thisDocument);
  } catch (e) {
    // Said, because the only other symptom is a gesture removed as a closed tab's after the reload.
    console.warn(
      `[TAB-COMMIT] could not carry this tab's identity across its reload: ${String(e)}`
    );
  }
}

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
    orderKey: nextOrderKey,
    documentId,
    adopts: (requester) => carriedRequester !== null && requester === carriedRequester,
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
