import type { IMlsService } from './IMlsService';
import { DELIVERY } from './frameDelivery';
import { promotedSinceLoad, refusesCommitsHere } from './stateAuthority';
import { openSealedBytes, sealBytes } from '$lib/encryption';
import { requireGraineRuntime } from '$lib/utils/graine/runtime';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  delegateCommitToLeader,
  type DelegatedCommitExecutors,
  type DelegationRefusal,
  type HandedFrameDelivery,
  type HandedOverBytes,
} from '$lib/utils/chat/tabCommitDelegation';

/**
 * A FOLLOWER TAB'S MLS FRAME, SENT BY THE LEADER (2026-11-11).
 *
 * Only the leader's copy of the MLS state sends (`BaseMlsService.sendMessage` refuses in a follower,
 * `FollowerTabSendError`): a frame sealed on a follower's copy spends a send generation the leader
 * never learns of and bumps the shared send ledger for a ratchet no disk holds. A gesture that sends
 * one frame and awaits it - a forwarded attachment, a salon invitation card, a group notice, a call
 * signal - goes through {@link sendFrameFromThisTab}: in the leader it is `sendMessage`; in a follower
 * it is the same gesture handover the commits use (`tabCommitDelegation.ts`), whose leader runs
 * `sendMessage` on its own state and answers the server's acceptance time.
 *
 * Queued sends (texts, replies, attachments, controls) already go through the outbox, which only the
 * leader drains; a salon message is sealed by the leader (`channelSeal.ts`). Nothing else may call
 * `sendMessage` from a path a follower reaches.
 */

/**
 * Why a frame a follower tab could not send itself was not sent for it:
 * - a {@link DelegationRefusal}: the leader's typed answer to the handover;
 * - `device-key-changed`: the leader could not open the sealed frame - the account's device key
 *   changed between the follower's seal and the leader's open (a PIN change); nothing was sent;
 * - `reload-owed`: this tab was promoted to leader IN PLACE and reloads to read the state as it now
 *   stands - its copy may not send, and there is no other leader to hand the frame to. Refused at
 *   once, never written as a request nobody would run.
 */
export type FrameNotSentReason = DelegationRefusal | 'device-key-changed' | 'reload-owed';

/** A frame this tab could not send itself was not sent for it either, for a typed reason. */
export class FrameNotHandedError extends Error {
  constructor(
    readonly groupId: string,
    readonly reason: FrameNotSentReason
  ) {
    super(
      `the MLS frame of ${groupId.slice(0, 8)}... handed to the leader tab was not sent (${reason})`
    );
    this.name = 'FrameNotHandedError';
  }
}

/**
 * Whether this document is the leader promoted in place, its reload owed: it may not send, and
 * nothing would run a request it handed over (it is the leader, and serves nothing on its copy).
 * `what` names the gesture in the line that says so.
 */
export function promotionReloadOwed(what: string): boolean {
  if (!promotedSinceLoad()) return false;
  console.warn(
    `[SEND] ${what} refused: this tab has just become the leader and reloads to read the MLS state as it stands - nothing sent, nothing handed over`
  );
  return true;
}

/** Seals `bytes` under the account's device key for a handover record - see {@link HandedOverBytes}. */
export async function sealForHandover(bytes: Uint8Array): Promise<HandedOverBytes> {
  const { deviceKey } = requireGraineRuntime('cannot hand a frame to the leader tab');
  const sealed = await sealBytes(bytes, deviceKey());
  return { iv: toBase64(sealed.iv), cipherText: toBase64(sealed.cipherText) };
}

/**
 * Opens what a follower sealed for the leader. `null` when the tag does not verify: the device key
 * changed between the two (a PIN change) - an ANSWER the executor carries back as
 * `device-key-changed`, never a throw, and never a guess at the bytes.
 */
export async function openHandedOver(sealed: HandedOverBytes): Promise<Uint8Array | null> {
  const { deviceKey } = requireGraineRuntime('cannot open a frame handed by a follower tab');
  return openSealedBytes(fromBase64(sealed.cipherText), fromBase64(sealed.iv), deviceKey());
}

/**
 * Sends one application frame from whichever tab the gesture is made in, and resolves with the
 * server's acceptance time - see the module comment.
 *
 * @throws {FrameNotHandedError} in a follower, when the leader did not send it (closed, locked, a
 *   device key changed, or a failure it met), and in a leader promoted in place before its reload -
 *   the caller's existing failed-send branch.
 */
export async function sendFrameFromThisTab(
  mlsService: Pick<IMlsService, 'sendMessage'>,
  groupId: string,
  bytes: Uint8Array,
  options: { messageId?: string; delivery?: HandedFrameDelivery } = {}
): Promise<{ receivedAt: number | null }> {
  const delivery = options.delivery ?? 'visible';
  if (!refusesCommitsHere()) {
    const sent = await mlsService.sendMessage(
      groupId,
      bytes,
      options.messageId,
      DELIVERY[delivery]
    );
    return { receivedAt: sent.receivedAt };
  }
  if (promotionReloadOwed(`the frame of ${groupId.slice(0, 8)}...`)) {
    throw new FrameNotHandedError(groupId, 'reload-owed');
  }
  const answer = await delegateCommitToLeader({
    kind: 'emit-frame',
    groupId,
    frame: await sealForHandover(bytes),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    delivery,
  });
  if (answer.status === 'refused') {
    console.warn(
      `[SEND] ${groupId.slice(0, 8)}... frame handed to the leader tab was not sent: ${answer.reason}`
    );
    throw new FrameNotHandedError(groupId, answer.reason);
  }
  if ('unopened' in answer.value) {
    console.warn(
      `[SEND] ${groupId.slice(0, 8)}... frame handed to the leader tab was not sent: the device key changed before it opened it`
    );
    throw new FrameNotHandedError(groupId, answer.value.unopened);
  }
  console.debug(`[SEND] ${groupId.slice(0, 8)}... frame sent by the leader tab for this one`);
  return answer.value;
}

/** The leader half: sends a frame a follower handed over, on this tab's own state. */
export function frameHandoverExecutors(
  ensureMls: () => Pick<IMlsService, 'sendMessage'>
): Pick<DelegatedCommitExecutors, 'emit-frame'> {
  return {
    'emit-frame': async (op) => {
      const bytes = await openHandedOver(op.frame);
      if (!bytes) {
        console.warn(
          `[SEND] ${op.groupId.slice(0, 8)}... a follower's frame does not open under this device key (changed since it was sealed) - not sent`
        );
        return { unopened: 'device-key-changed' };
      }
      const sent = await ensureMls().sendMessage(
        op.groupId,
        bytes,
        op.messageId,
        DELIVERY[op.delivery]
      );
      console.debug(`[SEND] ${op.groupId.slice(0, 8)}... frame sent for a follower tab`);
      return { receivedAt: sent.receivedAt };
    },
  };
}
