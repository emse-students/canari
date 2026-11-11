import type { IMlsService } from './IMlsService';
import { DELIVERY } from './frameDelivery';
import { refusesCommitsHere } from './stateAuthority';
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

/** A frame a follower handed to the leader was not sent by it, for the typed reason the leader gave. */
export class FrameNotHandedError extends Error {
  constructor(
    readonly groupId: string,
    readonly reason: DelegationRefusal
  ) {
    super(
      `the MLS frame of ${groupId.slice(0, 8)}... handed to the leader tab was not sent (${reason})`
    );
    this.name = 'FrameNotHandedError';
  }
}

/** Seals `bytes` under the account's device key for a handover record - see {@link HandedOverBytes}. */
export async function sealForHandover(bytes: Uint8Array): Promise<HandedOverBytes> {
  const { deviceKey } = requireGraineRuntime('cannot hand a frame to the leader tab');
  const sealed = await sealBytes(bytes, deviceKey());
  return { iv: toBase64(sealed.iv), cipherText: toBase64(sealed.cipherText) };
}

/**
 * Opens what a follower sealed for the leader. Throws when the tag does not verify (a device key
 * changed between the two) - the executor's throw is the request's `failed`, never a guess.
 */
export async function openHandedOver(sealed: HandedOverBytes): Promise<Uint8Array> {
  const { deviceKey } = requireGraineRuntime('cannot open a frame handed by a follower tab');
  const bytes = await openSealedBytes(
    fromBase64(sealed.cipherText),
    fromBase64(sealed.iv),
    deviceKey()
  );
  if (!bytes) throw new Error('a handed-over payload does not open under this device key');
  return bytes;
}

/**
 * Sends one application frame from whichever tab the gesture is made in, and resolves with the
 * server's acceptance time - see the module comment.
 *
 * @throws {FrameNotHandedError} in a follower, when the leader did not send it (closed, locked, or a
 *   failure it met) - the caller's existing failed-send branch.
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
