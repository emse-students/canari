import type { IMlsService } from '$lib/mls-client/IMlsService';
import { ChannelApiError, type ChannelService } from '$lib/services/ChannelService';
import { requestCommunityHistory } from './repair';
import { reconcileDistributionGroupRoster } from './rosterReconcile';

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
  if (known && mlsService.getLocalGroups().includes(known)) {
    // Already in the group - but not necessarily holding anything. A device that joined while its
    // answerer was offline would never ask again if the ask lived only on the joining branch, and
    // the request is exactly what decides whether it is needed.
    await reconcileRoster(channelService, workspaceId, log);
    await askForHistory(workspaceId, log);
    return true;
  }

  let ref: { groupId: string; groupInfo: string | null; baseEpoch: number | null };
  try {
    ref = await channelService.getDistributionGroup(workspaceId);
  } catch (e) {
    // The three causes need three different responses and only the code tells them apart: a
    // community with no group at all is a server-side gap somebody has to fix, a 403 means this
    // user is no longer a member, and anything else is transport. Never branched on the sentence.
    if (e instanceof ChannelApiError && e.code === 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP') {
      log(
        `[GRAINE] community ${workspaceId.slice(0, 8)}... has NO distribution group - its salons cannot carry seeds`
      );
      return false;
    }
    log(
      `[GRAINE] could not read the distribution group of ${workspaceId.slice(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  const joined = await mlsService.ensureDistributionGroup(workspaceId, ref);
  if (!joined) {
    log(
      `[GRAINE] could not join the distribution group of community ${workspaceId.slice(0, 8)}...`
    );
    return false;
  }

  await reconcileRoster(channelService, workspaceId, log);
  await askForHistory(workspaceId, log);
  return true;
}

/**
 * Makes the group's tree agree with the community's roster, best-effort.
 *
 * ON BOTH BRANCHES, and that is the point: the device that just joined is as able to carry a
 * departure as the one that has been in the group for a week, and a mechanism that only ran on one
 * of them would leave a community whose members all reconnect fresh with a tree nobody prunes.
 *
 * It must never fail the join, for the same reason the history request must not: a community whose
 * tree still holds a departed leaf works for every message from now on, badly, and refusing to load
 * it would only mean nobody ever prunes it.
 */
async function reconcileRoster(
  channelService: ChannelService,
  workspaceId: string,
  log: (message: string) => void
): Promise<void> {
  try {
    await reconcileDistributionGroupRoster(channelService, workspaceId, log);
  } catch (e) {
    log(
      `[GRAINE] roster reconciliation failed for ${workspaceId.slice(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Asks the community for a joiner's history, best-effort.
 *
 * ENTERING THE GROUP IS WHAT MAKES ASKING POSSIBLE, so asking belongs here rather than in a caller
 * that would have to know it had just happened. The request decides for itself whether it is needed
 * (this device holds no seed for the community) and whether it has already been made - see
 * {@link requestCommunityHistory}.
 *
 * It must never fail the join: a community whose group is held but whose past is missing still
 * works for every message from now on, and the failure is reported rather than propagated.
 */
async function askForHistory(workspaceId: string, log: (message: string) => void): Promise<void> {
  try {
    await requestCommunityHistory(workspaceId);
  } catch (e) {
    log(
      `[GRAINE] could not ask for the history of ${workspaceId.slice(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
