import type { IMlsService } from '$lib/mls-client/IMlsService';
import {
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import { ChannelApiError, type ChannelService } from '$lib/services/ChannelService';
import { requestCommunityHistory } from './repair';
import { reconcileDistributionGroupRoster } from './rosterReconcile';

/**
 * Joining a Graine key-distribution group, on first use - a community's, or a private salon's.
 *
 * WHY THIS SITS BETWEEN THE TWO SERVICES. The group id and its published base come from
 * social-service, which is the only service holding the roster and therefore the only one that may
 * hand out a GroupInfo - the GroupInfo being the capability to enter the group and read every seed
 * on it. Everything after that is MLS. Neither layer should learn to speak the other's language, so
 * the seam is here: one function, called wherever a community or a private salon is loaded.
 *
 * Protocol and the reasoning behind the split: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Ensures this device is in `scope`'s key-distribution group, joining or creating it.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT. The early return is derived from state that already exists - the
 * registered group id and the local MLS group list - rather than from a "done" flag, so it stays
 * correct across a state reload that a flag would have lied about.
 *
 * ONE FUNCTION FOR BOTH SCOPES, because it is one mechanism: a private salon's group differs only
 * in whose roster it carries, and a second copy of this would be a second place for the join, the
 * reconciliation and the history request to drift apart.
 *
 * @returns true when the device holds the group afterwards. False is a REPORTED failure, not a
 *   silent one: every branch that returns it has logged which of the causes it was.
 */
export async function ensureDistributionGroupFor(
  mlsService: IMlsService,
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  const known = mlsService.distributionGroupFor(scope);
  if (known && mlsService.getLocalGroups().includes(known)) {
    // Already in the group - but not necessarily holding anything. A device that joined while its
    // answerer was offline would never ask again if the ask lived only on the joining branch, and
    // the request is exactly what decides whether it is needed.
    await reconcileRoster(channelService, scope, log);
    await askForHistory(scope, log);
    return true;
  }

  let ref: { groupId: string; groupInfo: string | null; baseEpoch: number | null };
  try {
    ref = await channelService.getDistributionGroup(scope);
  } catch (e) {
    // The causes need different responses and only the code tells them apart: a scope with no group
    // at all is a server-side gap somebody has to fix, a 403 means this user may no longer read it,
    // and anything else is transport. Never branched on the sentence.
    if (
      e instanceof ChannelApiError &&
      (e.code === 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP' ||
        e.code === 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP')
    ) {
      log(`[GRAINE] ${scopeLabel(scope)} has NO distribution group - it cannot carry seeds`);
      return false;
    }
    log(
      `[GRAINE] could not read the distribution group of ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  const joined = await mlsService.ensureDistributionGroup(scope, ref);
  if (!joined) {
    log(`[GRAINE] could not join the distribution group of ${scopeLabel(scope)}`);
    return false;
  }

  await reconcileRoster(channelService, scope, log);
  await askForHistory(scope, log);
  return true;
}

/** {@link ensureDistributionGroupFor} for a whole community. */
export function ensureCommunityDistributionGroup(
  mlsService: IMlsService,
  channelService: ChannelService,
  workspaceId: string,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  return ensureDistributionGroupFor(mlsService, channelService, workspaceScope(workspaceId), log);
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
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  try {
    await reconcileDistributionGroupRoster(channelService, scope, log);
  } catch (e) {
    log(
      `[GRAINE] roster reconciliation failed for ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
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
 * ONLY ON THE COMMUNITY SCOPE, and that is a decision rather than an omission. The request means
 * "this device holds nothing at all for this community", which a salon join cannot answer: a member
 * joining a private salon already holds the community's seeds, so the ask would short-circuit and
 * they would still be missing the salon's past. What recovers that is the per-message repair, which
 * asks a named holder for the exact sessions a message needs - see `repair.ts`.
 *
 * It must never fail the join: a community whose group is held but whose past is missing still
 * works for every message from now on, and the failure is reported rather than propagated.
 */
async function askForHistory(
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  if (scope.kind !== 'workspace') return;
  try {
    await requestCommunityHistory(scope.workspaceId);
  } catch (e) {
    log(
      `[GRAINE] could not ask for the history of ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
