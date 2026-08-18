import type { IMlsService } from '$lib/mls-client/IMlsService';
import { ChannelApiError, type ChannelService } from '$lib/services/ChannelService';

/**
 * Joining a community's Graine key-distribution group, on first use.
 *
 * WHY THIS SITS BETWEEN THE TWO SERVICES. The group id and its published base come from
 * social-service, which is the only service holding community membership and therefore the only one
 * that may hand out a GroupInfo - the GroupInfo being the capability to enter the group and read
 * every seed on it. Everything after that is MLS. Neither layer should learn to speak the other's
 * language, so the seam is here: one function, called wherever a community is loaded.
 *
 * Protocol and the reasoning behind the split: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Ensures this device is in `workspaceId`'s key-distribution group, joining or creating it.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT. The early return is derived from state that already exists - the
 * registered group id and the local MLS group list - rather than from a "done" flag, so it stays
 * correct across a state reload that a flag would have lied about.
 *
 * @returns true when the device holds the group afterwards. False is a REPORTED failure, not a
 *   silent one: every branch that returns it has logged which of the causes it was.
 */
export async function ensureCommunityDistributionGroup(
  mlsService: IMlsService,
  channelService: ChannelService,
  workspaceId: string,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  const known = mlsService.distributionGroupFor(workspaceId);
  if (known && mlsService.getLocalGroups().includes(known)) return true;

  let ref: { groupId: string; groupInfo: string | null; baseEpoch: number | null };
  try {
    ref = await channelService.getDistributionGroup(workspaceId);
  } catch (e) {
    // The three causes need three different responses and only the code tells them apart: a
    // community with no group at all is a server-side gap somebody has to fix, a 403 means this
    // user is no longer a member, and anything else is transport. Never branched on the sentence.
    if (e instanceof ChannelApiError && e.code === 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP') {
      log(
        `[GRAINE] community ${workspaceId.slice(0, 8)}… has NO distribution group - its salons cannot carry seeds`
      );
      return false;
    }
    log(
      `[GRAINE] could not read the distribution group of ${workspaceId.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  const joined = await mlsService.ensureDistributionGroup(workspaceId, ref);
  if (!joined) {
    log(`[GRAINE] could not join the distribution group of community ${workspaceId.slice(0, 8)}…`);
  }
  return joined;
}
