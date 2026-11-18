import type { IMlsService } from './IMlsService';
import { DELIVERY } from './frameDelivery';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { FollowerTabSendError } from './commitSubmission';
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
  type HandoverUnsent,
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
 *   once, never written as a request nobody would run;
 * - `lead-lost`: the leader that took the request lost the lead before it posted the frame
 *   ({@link HandoverUnsent}) - nothing was posted. Never handed on a second time: one gesture is one
 *   request, so the handover terminates whatever the lead does.
 */
export type FrameNotSentReason =
  | DelegationRefusal
  | 'device-key-changed'
  | 'reload-owed'
  | HandoverUnsent;

/**
 * The handover answers after which the frame's FATE IS UNKNOWN - never "not sent":
 * - `leader-gone`: the leader died holding the request, and may have posted it before it died
 *   (`tabCommitDelegation.ts`: never run again, for that very reason);
 * - `failed`: the leader's executor threw instead of answering - its own transport failure among
 *   others - so whether its post reached the server is exactly what the throw did not say.
 * Every other reason is a proof that nothing was posted (refused before the run, a key that did not
 * open, a lead lost before the post).
 */
const FRAME_FATE_UNKNOWN: ReadonlySet<FrameNotSentReason> = new Set(['leader-gone', 'failed']);

/**
 * A frame this tab could not send itself was not sent for it either, for a typed reason - or was
 * handed to a leader that may have sent it ({@link fateUnknown}).
 */
export class FrameNotHandedError extends Error {
  /** True when the frame may be on the server all the same - see {@link FRAME_FATE_UNKNOWN}. */
  readonly fateUnknown: boolean;
  constructor(
    readonly groupId: string,
    readonly reason: FrameNotSentReason
  ) {
    super(
      `the MLS frame of ${groupId.slice(0, 8)}... handed to the leader tab was not sent (${reason})`
    );
    this.name = 'FrameNotHandedError';
    this.fateUnknown = FRAME_FATE_UNKNOWN.has(reason);
  }
}

/**
 * Whether a failed frame send left the frame's fate UNKNOWN - the one predicate a caller that must
 * not read "no answer" as "not sent" asks, decided by type at the throw: no answer from the server
 * ({@link isTransportFailure}), or a handover to a leader that may have posted it.
 */
export function isFrameFateUnknown(error: unknown): boolean {
  return isTransportFailure(error) || (error instanceof FrameNotHandedError && error.fateUnknown);
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
 * A SEND BEGUN WHILE THIS TAB LED AND REFUSED BECAUSE THE LEAD LEFT DURING IT (`sendMessage`'s
 * `FollowerTabSendError('lead-lost')`: nothing was posted) is handed to the leader like any
 * follower's - the lead moved, the gesture did not. Rethrown, it reached each caller as a type none
 * of them names, and a caller that only logs (the channel invitation) lost it.
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
    try {
      const sent = await mlsService.sendMessage(
        groupId,
        bytes,
        options.messageId,
        DELIVERY[delivery]
      );
      return { receivedAt: sent.receivedAt };
    } catch (e) {
      if (!(e instanceof FollowerTabSendError) || e.refusal !== 'lead-lost') throw e;
      console.warn(
        `[SEND] ${groupId.slice(0, 8)}... the lead left this tab during the send, nothing was posted - the frame is handed to the leader tab`
      );
    }
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
  if ('unsent' in answer.value) {
    console.warn(
      `[SEND] ${groupId.slice(0, 8)}... frame handed to the leader tab was not sent: that tab lost the lead before posting it`
    );
    throw new FrameNotHandedError(groupId, answer.value.unsent);
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
      // THE LEAD CAN LEAVE THIS TAB AT ANY AWAIT OF THE RUN (a freeze, a handover to a visible tab):
      // an expected event, answered BY VALUE. `sendMessage` NEVER DELEGATES, and it classifies the
      // loss at its own throw wherever it is met before the post - at its entry (which covers the
      // open above), after a kept commit's settlement, before the encrypt, after the count
      // (`FollowerTabSendError` `lead-lost`, nothing posted). A loss met during the post is a frame
      // on the wire: sent, and answered as such. Every other failure still throws: a defect.
      let sent;
      try {
        sent = await ensureMls().sendMessage(
          op.groupId,
          bytes,
          op.messageId,
          DELIVERY[op.delivery]
        );
      } catch (e) {
        if (!(e instanceof FollowerTabSendError) || e.refusal !== 'lead-lost') throw e;
        console.warn(
          `[SEND] ${op.groupId.slice(0, 8)}... a follower's frame was not sent: the lead left this tab during the run - nothing posted, the follower is told`
        );
        return { unsent: 'lead-lost' };
      }
      console.debug(`[SEND] ${op.groupId.slice(0, 8)}... frame sent for a follower tab`);
      return { receivedAt: sent.receivedAt };
    },
  };
}
