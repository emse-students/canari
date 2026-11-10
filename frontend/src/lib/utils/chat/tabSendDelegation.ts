/**
 * A FOLLOWER TAB'S SENDS AND CALL KEYS, RUN BY THE LEADER (reviews of #3326, 2026-11-10).
 *
 * Only the leader copy may seal a frame or read an exporter secret: a follower's copy is frozen at
 * its load, so its send ratchet is behind every generation the leader put on the wire (its frame is
 * a drop at the peer) and its epoch is behind every commit since (a call keyed from it never
 * decrypts). The follower HANDS the operation to the leader over the commit delegation
 * (`tabCommitDelegation.ts`, kinds `send`, `export-secret`, `call-preflight`): the leader runs its
 * own `sendMessage` / `exportSecret` and answers the result, or its failure as data, and the caller
 * awaits that answer as if it had run it.
 *
 * THE SECRET PART IS SEALED. A request's plaintext (a message, a media key, Graine key material, an
 * exporter label and context) and an exported secret cross the store sealed under the device key
 * with `encryptData` - the cipher of every encrypted row of this device - and the delegation drops
 * the sealed payload from the record the moment a leader claims it. A record at rest holds ids only.
 *
 * TERMINATION is the delegation's, never a clock: a request is answered by a leader that serves it
 * (`done`), refuses it (PIN gate, another account: `leader-unavailable`, `not-delegable`), or proves
 * the leader that claimed it dead by its free run lock (`leader-gone`, never run twice). A request
 * nobody has claimed yet waits for the next leader that loaded its state as leader - and the only
 * candidate besides another tab is this document itself, whose promotion in place reloads it, which
 * ends the wait with the document.
 *
 * `leader-gone` ON A SEND IS AN UNKNOWN OUTCOME ({@link DelegatedSendOutcomeUnknownError}): the dead
 * leader may have posted the frame. Every other refusal proves nothing ran
 * ({@link FollowerTabSendError}), and so does a document leading on a follower's copy, refused
 * before any hand-over - it has nobody to hand to and must not seal on its own copy.
 */
import { decryptData, encryptData, PayloadUnreadableError } from '$lib/encryption';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import type { SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import {
  CommitOutcomeUnknownError,
  DelegatedSendFailedError,
  DelegatedSendOutcomeUnknownError,
  FollowerTabSendError,
} from '$lib/mls-client/commitSubmission';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { callHoldLockName } from '$lib/mls-client/leafRefresh';
import type { CallPreflightRefusal } from '$lib/utils/callFailure';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { TransportFailureError } from '$lib/utils/transportFailure';
import {
  delegateCommitToLeader,
  type DelegatedCommitExecutors,
  type DelegatedCommitKind,
  type DelegatedCommitOp,
  type DelegatedErrorClass,
  type DelegatedOutcome,
  type DelegationLocks,
  type SealedTabPayload,
} from './tabCommitDelegation';

const NAMED_DELIVERIES = ['visible', 'mutation', 'transport', 'keyMaterial'] as const;

/** A frame's delivery as plain data: a `DELIVERY` constant by NAME, an addressed one by its fields. */
export type DelegatedDelivery =
  | { named: (typeof NAMED_DELIVERIES)[number] }
  | { silent: boolean; durable: boolean; recipients?: string[] };

/** A delivery as plain data: a `DELIVERY` constant by its name, an addressed one by its fields. */
export function encodeDelivery(delivery: FrameDelivery): DelegatedDelivery {
  const named = NAMED_DELIVERIES.find((name) => DELIVERY[name] === delivery);
  if (named) return { named };
  return {
    silent: delivery.silent,
    durable: delivery.durable,
    ...(delivery.recipients ? { recipients: [...delivery.recipients] } : {}),
  };
}

/** The delivery the leader passes to its `sendMessage`: the SAME constant, so identity checks hold. */
export function decodeDelivery(delivery: DelegatedDelivery): FrameDelivery {
  return 'named' in delivery ? DELIVERY[delivery.named] : delivery;
}

/** What a sealed `send` carries. */
interface SendPayload {
  message: string;
  delivery: DelegatedDelivery;
}

/** What a sealed `export-secret` carries. */
interface ExportPayload {
  label: string;
  context: string;
  keyLen: number;
}

/** Seals `data` under the device key, as every encrypted row of this device is. */
export async function sealTabPayload(
  data: unknown,
  deviceKeyB64: string
): Promise<SealedTabPayload> {
  const { iv, cipherText } = await encryptData(data, deviceKeyB64);
  return { iv: toBase64(iv), cipherText: toBase64(cipherText) };
}

/** Opens a {@link sealTabPayload}; throws `PayloadUnreadableError` under another key. */
export async function openTabPayload<T>(
  sealed: SealedTabPayload,
  deviceKeyB64: string
): Promise<T> {
  return (await decryptData(
    fromBase64(sealed.cipherText),
    fromBase64(sealed.iv),
    deviceKeyB64
  )) as T;
}

/**
 * The leader's error as the closed set that crosses the tab boundary - by CLASS, never by name or
 * message ({@link DelegatedErrorClass}).
 */
export function classifyLeaderError(e: unknown): DelegatedErrorClass {
  if (e instanceof PayloadUnreadableError) return 'unreadable';
  if (e instanceof FollowerTabSendError) return 'lead-lost';
  if (e instanceof CommitOutcomeUnknownError) return 'commit-outcome-unknown';
  if (e instanceof TransportFailureError) return 'transport';
  if (e instanceof ApiRefusalError) return 'refused';
  return 'other';
}

/**
 * Whether an operation asked of this document can be carried by a leader tab: it is a follower (a
 * leader holds the lock elsewhere) in an engine with Web Locks. False for a leader promoted in place,
 * whose reload is owed - nothing leads elsewhere, and its own copy may not seal. Whether that leader
 * can carry it NOW (its PIN gate, its account) only the leader answers: {@link callPreflightThroughLeaderTab}.
 */
export function leaderTabCarriesSends(): boolean {
  return getTabLeadership() === 'follower' && typeof navigator !== 'undefined' && !!navigator.locks;
}

/** What the follower half reads, injected so a test runs the two halves in one module. */
export interface ThroughLeaderDeps {
  leadership(): ReturnType<typeof getTabLeadership>;
  delegate<K extends DelegatedCommitKind>(
    op: Extract<DelegatedCommitOp, { kind: K }>
  ): Promise<DelegatedOutcome<K>>;
  /** This document's Web Locks; null in an engine without them. */
  locks?: DelegationLocks | null;
}

/** The browser's Web Locks, or null where the engine has none. */
function browserLocks(): DelegationLocks | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

const productionDeps: ThroughLeaderDeps = {
  leadership: getTabLeadership,
  delegate: (op) => delegateCommitToLeader(op),
  get locks() {
    return browserLocks();
  },
};

/** The no-hand-over refusals, before anything is sealed or stored. */
function refuseWithoutLeader(groupId: string, deviceKeyB64: string, deps: ThroughLeaderDeps): void {
  // Leading on a follower's copy (promotion reload owed): there is nobody to hand it to.
  if (deps.leadership() !== 'follower') throw new FollowerTabSendError(groupId, 'no-leader');
  if (!deviceKeyB64) throw new FollowerTabSendError(groupId, 'no-device-key');
}

/**
 * From a document without the leader copy: has the leader tab seal and post `messageBytes` to
 * `groupId`, and resolves with the frame it sent. Rejects with {@link FollowerTabSendError} when no
 * leader carried it, {@link DelegatedSendOutcomeUnknownError} when the leader died running it, and
 * {@link DelegatedSendFailedError} when it ran it and failed.
 */
export async function sendThroughLeaderTab(
  groupId: string,
  messageBytes: Uint8Array,
  delivery: FrameDelivery,
  deviceKeyB64: string,
  deps: ThroughLeaderDeps = productionDeps
): Promise<SentFrame> {
  refuseWithoutLeader(groupId, deviceKeyB64, deps);
  const payload: SendPayload = {
    message: toBase64(messageBytes),
    delivery: encodeDelivery(delivery),
  };
  const answer = await deps.delegate<'send'>({
    kind: 'send',
    groupId,
    payload: await sealTabPayload(payload, deviceKeyB64),
  });
  if (answer.status === 'refused') {
    if (answer.reason === 'leader-gone') throw new DelegatedSendOutcomeUnknownError(groupId);
    throw new FollowerTabSendError(groupId, answer.reason);
  }
  const result = answer.value;
  if (result.status === 'failed') {
    throw new DelegatedSendFailedError(groupId, result.errorClass, result.message);
  }
  return {
    sealed: fromBase64(result.sealed),
    authorProof: fromBase64(result.authorProof),
    receivedAt: result.receivedAt,
  };
}

/**
 * From a document without the leader copy: the exporter secret of `groupId` read by the leader tab,
 * at ITS epoch - the one a member's device keys the same call from. Only the secret comes back,
 * sealed; never any state. Rejects like {@link sendThroughLeaderTab}, a dead leader included (an
 * export has no effect to be unknown about).
 */
export async function exportSecretThroughLeaderTab(
  groupId: string,
  label: string,
  context: Uint8Array,
  keyLen: number,
  deviceKeyB64: string,
  deps: ThroughLeaderDeps = productionDeps
): Promise<Uint8Array> {
  refuseWithoutLeader(groupId, deviceKeyB64, deps);
  const payload: ExportPayload = { label, context: toBase64(context), keyLen };
  const answer = await deps.delegate<'export-secret'>({
    kind: 'export-secret',
    groupId,
    payload: await sealTabPayload(payload, deviceKeyB64),
  });
  if (answer.status === 'refused') {
    throw new FollowerTabSendError(
      groupId,
      answer.reason === 'leader-gone' ? 'failed' : answer.reason
    );
  }
  const result = answer.value;
  if (result.status === 'failed') {
    throw new DelegatedSendFailedError(groupId, result.errorClass, result.message, 'export-secret');
  }
  return fromBase64(await openTabPayload<string>(result.secret, deviceKeyB64));
}

/** What a call preflight came to, and the hold it leaves for the call's life. */
export interface CallPreflight {
  answer: 'ready' | CallPreflightRefusal;
  /**
   * Lifts the hold on the group's leaf refresh (idempotent): called at the call's end. A document
   * that dies without calling it releases it all the same - its lock goes with it.
   */
  releaseHold(): void;
}

/**
 * Asks the leader tab whether it can carry a call's frames NOW (its session up, this account),
 * before anything is created, rung or keyed - and, on `ready`, leaves the group's leaf refresh HELD
 * for the call's life. The hold is a Web Lock THIS document holds, taken before the question, which
 * every leaf refresh reads in the browser's lock table (`callHoldLockHeld`): it binds the leader
 * that commits - the one asked, or any elected after a handover - so a refresh between this call's
 * export and the other end's never keys the two ends from different epochs. The leader answers
 * `ready` only once the group holds no staged commit (`settleForCallKeys`): `commit-unresolved`
 * otherwise. Never rejects - every failure is an answer naming its cause.
 */
export async function callPreflightThroughLeaderTab(
  groupId: string,
  deps: ThroughLeaderDeps = productionDeps
): Promise<CallPreflight> {
  const none = () => {};
  if (deps.leadership() !== 'follower') return { answer: 'no-leader', releaseHold: none };
  if (!deps.locks) return { answer: 'not-delegable', releaseHold: none };
  let hold: { release: () => void };
  try {
    hold = await takeHoldLock(groupId, deps.locks);
  } catch (e) {
    console.warn(
      `[TAB-SEND] the call hold lock on ${groupId.slice(0, 8)}... could not be taken: ${String(e).slice(0, 120)}`
    );
    return { answer: 'hold-lock-failed', releaseHold: none };
  }
  const answer = await deps.delegate<'call-preflight'>({ kind: 'call-preflight', groupId });
  if (answer.status === 'done' && answer.value === 'ready') {
    return { answer: 'ready', releaseHold: hold.release };
  }
  hold.release();
  if (answer.status === 'done') return { answer: answer.value, releaseHold: none };
  return { answer: answer.reason === 'leader-gone' ? 'failed' : answer.reason, releaseHold: none };
}

/** What the leader half needs of its MLS client. */
export interface LeaderMls {
  sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    frameDelivery?: FrameDelivery
  ): Promise<SentFrame>;
  exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;
  /**
   * Resolves once `groupId` sits at a settled epoch: a leaf refresh running here has finished, and
   * no staged commit is left. @throws {CommitOutcomeUnknownError} when one is still unanswered.
   */
  settleForCallKeys(groupId: string): Promise<void>;
}

/** A failure of the leader's run, as the answer that carries it. */
function failed(
  what: string,
  groupId: string,
  e: unknown
): { status: 'failed'; errorClass: DelegatedErrorClass; message: string } {
  const errorClass = classifyLeaderError(e);
  console.warn(
    `[TAB-SEND] a follower's ${what} in ${groupId.slice(0, 8)}... failed in the leader tab (${errorClass}): ${String(e).slice(0, 200)}`
  );
  // The message is for the LOG only (the class is what a caller reads), so it is the raw string.
  return { status: 'failed', errorClass, message: String(e).slice(0, 300) };
}

/**
 * The LEADER half: runs a follower's send, exporter read and call preflight on this tab's own MLS
 * client. A failure is an ANSWER (`failed`, its class carried as data), never an executor throw - an
 * executor throw is a defect and is reported at error by the delegation. The device key opens the
 * sealed payload; a payload sealed under another key is `unreadable`.
 */
export function delegatedSendExecutors(
  mls: () => Promise<LeaderMls>,
  deviceKey: () => string | null
): Pick<DelegatedCommitExecutors, 'send' | 'export-secret' | 'call-preflight'> {
  const open = async <T>(
    sealed: SealedTabPayload | undefined
  ): Promise<{ key: string; data: T }> => {
    const key = deviceKey();
    if (!sealed || !key) throw new PayloadUnreadableError();
    return { key, data: await openTabPayload<T>(sealed, key) };
  };
  return {
    send: async ({ groupId, payload }) => {
      try {
        const { data } = await open<SendPayload>(payload);
        const sent = await (
          await mls()
        ).sendMessage(groupId, fromBase64(data.message), undefined, decodeDelivery(data.delivery));
        return {
          status: 'sent',
          sealed: toBase64(sent.sealed),
          authorProof: toBase64(sent.authorProof),
          receivedAt: sent.receivedAt,
        };
      } catch (e) {
        return failed('send', groupId, e);
      }
    },
    'export-secret': async ({ groupId, payload }) => {
      try {
        const { key, data } = await open<ExportPayload>(payload);
        const secret = await (
          await mls()
        ).exportSecret(groupId, data.label, fromBase64(data.context), data.keyLen);
        const sealed = await sealTabPayload(toBase64(secret), key);
        secret.fill(0);
        return { status: 'exported', secret: sealed };
      } catch (e) {
        return failed('exporter read', groupId, e);
      }
    },
    // Reached only through the delegation's own gates: this leader serves (a live session, this
    // account, a state it loaded as leader). That IS the answer - once a refresh of the group
    // already running here has settled. The call's epoch is held by the asker's own lock, taken
    // before it asked, which every leaf refresh reads in the browser's lock table (`callHoldLockHeld`,
    // at its decision and again under the MLS lock) - here, and in whichever document leads after a
    // handover. A refresh decided BEFORE the lock existed may still commit, and a commit staged here
    // and not yet answered (an unknown outcome, or one this leader inherited) merges at the next
    // send: `ready` waits for the first and settles the second, so the keys this call exports next
    // are read at the epoch the group stays at. A commit still unanswered after its settlement is
    // `commit-unresolved` - no keys at an epoch nobody knows.
    'call-preflight': async ({ groupId }) => {
      try {
        await (await mls()).settleForCallKeys(groupId);
      } catch (e) {
        if (!(e instanceof CommitOutcomeUnknownError)) throw e;
        console.warn(
          `[TAB-SEND] a follower's call in ${groupId.slice(0, 8)}... refused: a staged commit is still unanswered after its settlement`
        );
        return 'commit-unresolved';
      }
      return 'ready';
    },
  };
}

/**
 * The call's hold: a Web Lock held until `release`, resolved once GRANTED - so it is in the lock
 * table before the leader is asked, and no refresh decided after the `ready` can miss it.
 */
function takeHoldLock(groupId: string, locks: DelegationLocks): Promise<{ release: () => void }> {
  return new Promise((granted, refused) => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(callHoldLockName(groupId), {}, () => {
        granted({ release });
        return held;
      })
      .catch(refused);
  });
}
