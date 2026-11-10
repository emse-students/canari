/**
 * A FOLLOWER TAB'S SEND, SEALED AND POSTED BY THE LEADER (review of #3326, 2026-11-10).
 *
 * Only the leader copy may seal a frame: a follower's send ratchet is behind every generation the
 * leader already put on the wire, so a frame it sealed was a drop at the peer. Refusing the send in a
 * follower broke every direct caller there (a call's invite, a media forward, a scroll-back request,
 * a salon invitation card), so the follower HANDS THE PLAINTEXT to the leader over the commit
 * delegation (`tabCommitDelegation.ts`, kind `send`): the leader runs its own `sendMessage` and
 * answers the frame, or its failure as data, and the caller awaits that answer as if it had sent.
 *
 * TERMINATION is the delegation's, never a clock: a request is answered by a leader that serves it
 * (`done`), refuses it (PIN gate, another account: `leader-unavailable`, `not-delegable`), or proves
 * the leader that claimed it dead by its free run lock (`leader-gone`, never run twice). A request
 * nobody has claimed yet waits for the next leader that loaded its state as leader - and the only
 * candidate besides another tab is this document itself, whose promotion in place reloads it, which
 * ends the wait with the document.
 *
 * NO LEADER REACHABLE IS REFUSED BEFORE ANY HAND-OVER ({@link FollowerTabSendError}): a document that
 * leads on a copy it loaded as a follower (its promotion reload owed) has no leader to hand to and
 * must not seal on its own copy.
 */
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import type { SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import { DelegatedSendFailedError, FollowerTabSendError } from '$lib/mls-client/commitSubmission';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  delegateCommitToLeader,
  type DelegatedCommitExecutors,
  type DelegatedDelivery,
  type DelegatedOutcome,
  type DelegatedCommitOp,
} from './tabCommitDelegation';

const NAMED_DELIVERIES = ['visible', 'mutation', 'transport', 'keyMaterial'] as const;

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

/**
 * Whether a send asked of this document can be carried by a leader tab: it is a follower (a leader
 * holds the lock elsewhere) in an engine with Web Locks. False for a leader promoted in place, whose
 * reload is owed - nothing leads elsewhere, and its own copy may not seal. Read by a gesture that
 * must refuse BEFORE it does anything a send would have to follow (a call's ring).
 */
export function leaderTabCarriesSends(): boolean {
  return getTabLeadership() === 'follower' && typeof navigator !== 'undefined' && !!navigator.locks;
}

/** What {@link sendThroughLeaderTab} reads, injected so a test runs the two halves in one module. */
export interface SendThroughLeaderDeps {
  leadership(): ReturnType<typeof getTabLeadership>;
  delegate(op: Extract<DelegatedCommitOp, { kind: 'send' }>): Promise<DelegatedOutcome<'send'>>;
}

const productionDeps: SendThroughLeaderDeps = {
  leadership: getTabLeadership,
  delegate: (op) => delegateCommitToLeader(op),
};

/**
 * From a document without the leader copy: has the leader tab seal and post `messageBytes` to
 * `groupId`, and resolves with the frame it sent. Rejects with {@link FollowerTabSendError} when no
 * leader could carry it, {@link DelegatedSendFailedError} when the leader ran it and failed.
 */
export async function sendThroughLeaderTab(
  groupId: string,
  messageBytes: Uint8Array,
  delivery: FrameDelivery,
  deps: SendThroughLeaderDeps = productionDeps
): Promise<SentFrame> {
  if (deps.leadership() !== 'follower') {
    // Leading on a follower's copy (promotion reload owed): there is nobody to hand it to.
    throw new FollowerTabSendError(groupId, 'no-leader');
  }
  const answer = await deps.delegate({
    kind: 'send',
    groupId,
    message: toBase64(messageBytes),
    delivery: encodeDelivery(delivery),
  });
  if (answer.status === 'refused') throw new FollowerTabSendError(groupId, answer.reason);
  const result = answer.value;
  if (result.status === 'failed') {
    throw new DelegatedSendFailedError(groupId, result.name, result.message);
  }
  return {
    sealed: fromBase64(result.sealed),
    authorProof: fromBase64(result.authorProof),
    receivedAt: result.receivedAt,
  };
}

/** The one method the leader half needs of its MLS client. */
export interface LeaderSender {
  sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    frameDelivery?: FrameDelivery
  ): Promise<SentFrame>;
}

/**
 * The LEADER half: runs a follower's send through this tab's own `sendMessage`. A failure of the
 * send is an ANSWER (`failed`, carried to the follower as data), not an executor throw - an executor
 * throw is a defect and is reported at error by the delegation.
 */
export function delegatedSendExecutor(
  mls: () => Promise<LeaderSender>
): Pick<DelegatedCommitExecutors, 'send'> {
  return {
    send: async ({ groupId, message, delivery }) => {
      try {
        const sent = await (
          await mls()
        ).sendMessage(groupId, fromBase64(message), undefined, decodeDelivery(delivery));
        return {
          status: 'sent',
          sealed: toBase64(sent.sealed),
          authorProof: toBase64(sent.authorProof),
          receivedAt: sent.receivedAt,
        };
      } catch (e) {
        console.warn(
          `[TAB-SEND] a follower's send to ${groupId.slice(0, 8)}... failed in the leader tab: ${String(e).slice(0, 200)}`
        );
        return {
          status: 'failed',
          name: e instanceof Error ? e.name : 'Error',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
