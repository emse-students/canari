import { GraineSealUnavailableError, type GraineSealUnavailableReason } from './sealUnavailable';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import type { GraineDistributionFrame, StoredGraineSession } from '$lib/db/types';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { encodeAppMessage, mkGraine } from '$lib/proto/codec';
import { toBase64 } from '$lib/utils/hex';
import { toWireSeed } from './wireSeed';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { isInEpochGap } from '$lib/utils/chat/epochGapRegistry';

/**
 * Putting a Graine seed into the hands of a community, over its MLS distribution group.
 *
 * ONE sealed frame reaches every member and every device, whatever the community's size - that is
 * the whole reason a distribution group exists rather than a per-member copy. At several hundred
 * members, the per-member shape was the measurement that ruled it out
 * (`docs/wiki/protocols/channel-encryption.md`).
 */

/** Why a scope's key group cannot carry a seed - the key-group half of the seal's reasons. */
export type KeyGroupUnavailableReason = Extract<GraineSealUnavailableReason, `key-group-${string}`>;

/** What each reason means, for the one line that names it. */
const KEY_GROUP_REASON_TEXT: Record<KeyGroupUnavailableReason, string> = {
  'key-group-unregistered': 'has no distribution group registered on this device',
  'key-group-not-held': 'has a distribution group this device holds no tree for',
  'key-group-unsettled': 'has a distribution group whose base the server has not arbitrated yet',
  'key-group-catching-up': 'has a distribution group behind its server, being caught up',
};

/** Thrown when a seed cannot be distributed because the scope's group is not usable. */
export class GraineDistributionUnavailableError extends GraineSealUnavailableError {
  constructor(
    readonly scope: DistributionScope,
    reason: KeyGroupUnavailableReason
  ) {
    super(
      `[GRAINE] ${scopeLabel(scope)} ${KEY_GROUP_REASON_TEXT[reason]} (${reason}) - ` +
        `nothing can be sealed for it until that changes`,
      reason
    );
    this.name = 'GraineDistributionUnavailableError';
  }
}

/**
 * The MLS epoch of a scope's distribution group, or null when nothing may ride it yet.
 *
 * Null is a real answer and never a zero: epoch 0 is a group that exists and has committed
 * nothing, which is a very different thing from a group this device cannot see.
 *
 * AND "HELD LOCALLY" IS NOT THE SAME QUESTION AS "USABLE". A group this device created moments ago
 * is in `getLocalGroups()` and answers epoch 0, yet it may still be discarded for having lost the
 * first-publish race - taking with it any outbound session minted against it, and leaving whatever
 * that session sealed unreadable for ever. So the third state is asked for explicitly, and a
 * caller that cannot send yet is told the same thing it is told when the group is absent: wait.
 *
 * AND "HELD" IS NOT "CURRENT". A group in the epoch-gap registry is BEHIND the server, and a seed
 * sealed at its epoch is read by no member: on production 2026-09-28 a device at epoch 5 of a key
 * group every other member had at 13 sealed its requests there. Null until the catch-up closes the
 * gap, like a group not yet joined.
 */
export function distributionEpochFor(
  mlsService: IMlsService,
  scope: DistributionScope
): number | null {
  const reading = readDistributionEpoch(mlsService, scope);
  return 'epoch' in reading ? reading.epoch : null;
}

/**
 * {@link distributionEpochFor} with the reason kept: the epoch, or WHICH of the four facts it asks
 * is missing. The seal reads this one, because its refusal is shown to a member and logged.
 */
export function readDistributionEpoch(
  mlsService: IMlsService,
  scope: DistributionScope
): { epoch: number } | { unavailable: KeyGroupUnavailableReason } {
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) return { unavailable: 'key-group-unregistered' };
  if (!holdsGroupState(mlsService, groupId)) return { unavailable: 'key-group-not-held' };
  if (!mlsService.isDistributionBaseSettled(groupId)) return { unavailable: 'key-group-unsettled' };
  if (isInEpochGap(groupId)) return { unavailable: 'key-group-catching-up' };
  return { epoch: mlsService.getEpoch(groupId) };
}

/**
 * Sends `session`'s seed to everyone on `scope`'s roster - a whole community, or the people who may
 * open one private salon.
 *
 * **Silent and durable** ({@link DELIVERY.keyMaterial}). Silent because it is key material and
 * there is nothing to show; durable because a member offline when it went out has no other way to
 * obtain it than to ask a peer, and asking costs a round trip per absence. A distribution group's
 * shared log carries seeds and nothing else, so the per-group cap is spent on exactly this.
 *
 * Throws rather than reporting a boolean: the caller mints a session and distributes it before
 * persisting anything, so a failure here has to unwind that, and a false would have to be turned
 * back into a throw by every caller anyway.
 *
 * **Returns the frame it posted**, which the session keeps and every message sealed under it
 * carries - so a phone opens the seed from the message's own push instead of racing a second one
 * (channel-encryption section 19). It is the exact ciphertext the key group's members receive.
 */
export async function distributeGraineSeed(
  mlsService: IMlsService,
  scope: DistributionScope,
  session: StoredGraineSession
): Promise<GraineDistributionFrame> {
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope, 'key-group-unregistered');

  const frame = encodeAppMessage({
    // The same wire form a repair relays, so a v2 session's endorsement leaves exactly as held.
    ...mkGraine(toWireSeed(session)),
    sentAt: session.createdAt,
  });
  const sealed = await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.keyMaterial);
  return { groupId, protoB64: toBase64(sealed) };
}
