import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { StoredGraineSession } from '$lib/db/types';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { encodeAppMessage, mkGraine } from '$lib/proto/codec';
import { fromBase64 } from '$lib/utils/hex';

/**
 * Putting a Graine seed into the hands of a community, over its MLS distribution group.
 *
 * ONE sealed frame reaches every member and every device, whatever the community's size - that is
 * the whole reason a distribution group exists rather than a per-member copy. At several hundred
 * members, the per-member shape was the measurement that ruled it out
 * (`docs/wiki/protocols/channel-encryption.md`).
 */

/** Thrown when a seed cannot be distributed because the community's group is not in hand. */
export class GraineDistributionUnavailableError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `[GRAINE] community ${workspaceId.slice(0, 8)} has no distribution group on this device - ` +
        `nothing can be sealed for it until the join lands`
    );
    this.name = 'GraineDistributionUnavailableError';
  }
}

/**
 * The MLS epoch of a community's distribution group, or null when this device has not joined it.
 *
 * Null is a real answer and never a zero: epoch 0 is a group that exists and has committed
 * nothing, which is a very different thing from a group this device cannot see.
 */
export function distributionEpochFor(mlsService: IMlsService, workspaceId: string): number | null {
  const groupId = mlsService.distributionGroupFor(workspaceId);
  if (!groupId || !mlsService.getLocalGroups().includes(groupId)) return null;
  return mlsService.getEpoch(groupId);
}

/**
 * Sends `session`'s seed to every member of `workspaceId`.
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
  workspaceId: string,
  session: StoredGraineSession
): Promise<void> {
  const groupId = mlsService.distributionGroupFor(workspaceId);
  if (!groupId) throw new GraineDistributionUnavailableError(workspaceId);

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
