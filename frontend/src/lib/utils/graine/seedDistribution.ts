import type { IMlsService } from '$lib/mls-client/IMlsService';
import { scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import type { StoredGraineSession } from '$lib/db/types';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { encodeAppMessage, mkGraine } from '$lib/proto/codec';
import { fromBase64 } from '$lib/utils/hex';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';

/**
 * Putting a Graine seed into the hands of a community, over its MLS distribution group.
 *
 * ONE sealed frame reaches every member and every device, whatever the community's size - that is
 * the whole reason a distribution group exists rather than a per-member copy. At several hundred
 * members, the per-member shape was the measurement that ruled it out
 * (`docs/wiki/protocols/channel-encryption.md`).
 */

/** Thrown when a seed cannot be distributed because the scope's group is not in hand. */
export class GraineDistributionUnavailableError extends Error {
  constructor(readonly scope: DistributionScope) {
    super(
      `[GRAINE] ${scopeLabel(scope)} has no distribution group on this device - ` +
        `nothing can be sealed for it until the join lands`
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
 */
export function distributionEpochFor(
  mlsService: IMlsService,
  scope: DistributionScope
): number | null {
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !holdsGroupState(mlsService, groupId)) return null;
  if (!mlsService.isDistributionBaseSettled(groupId)) return null;
  return mlsService.getEpoch(groupId);
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
 */
export async function distributeGraineSeed(
  mlsService: IMlsService,
  scope: DistributionScope,
  session: StoredGraineSession
): Promise<void> {
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) throw new GraineDistributionUnavailableError(scope);

  const frame = encodeAppMessage({
    ...mkGraine({
      channelId: session.channelId,
      sessionId: session.sessionId,
      seed: fromBase64(session.seedB64),
      firstIndex: session.firstIndex,
      createdAt: session.createdAt,
    }),
    sentAt: session.createdAt,
  });
  await mlsService.sendMessage(groupId, frame, undefined, DELIVERY.keyMaterial);
}
