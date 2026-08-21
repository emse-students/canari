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
 * IDEMPOTENT AND CHEAP TO REPEAT. Nothing here is derived from a "done" flag: the answer comes from
 * state that already exists, on BOTH sides - the group this device holds, and the delivery rows the
 * group holds for it. One of those alone is not membership. A device can hold the MLS group and be
 * routed nothing (it was evicted while offline), and a device routed something may not hold the
 * group yet (a fresh install). Only the pair says whether a join is owed - see the comment on the
 * comparison below, and `WP-REGRANT-1` in `docs/wiki/backlog.md` for what believing one of them
 * cost.
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
  // WHAT THIS DEVICE HOLDS, BEFORE ASKING. Only used to decide what a FAILED read may conclude; the
  // membership decision below is taken against the group the SERVER names, not this one.
  const known = mlsService.distributionGroupFor(scope);
  const heldLocally = !!known && mlsService.getLocalGroups().includes(known);

  let ref: {
    groupId: string;
    groupInfo: string | null;
    baseEpoch: number | null;
    memberDevices?: string[];
  };
  try {
    ref = await channelService.getDistributionGroup(scope);
  } catch (e) {
    // A HELD GROUP SURVIVES A FAILED READ. This fetch used to happen only when the group was NOT
    // held, so transport could never break a healthy load; now that the answer below depends on it,
    // a fetch that threw must leave that path exactly as it was. A failed read is not "the server
    // says you are out" - the same rule the roster reconciliation already obeys.
    if (heldLocally) {
      log(
        `[GRAINE] could not re-read the distribution group of ${scopeLabel(scope)} (${e instanceof Error ? e.message : String(e)}) - keeping the one this device holds`
      );
      await reconcileRoster(channelService, scope, log);
      await askForHistory(scope, log);
      return true;
    }
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

  // WHAT THIS DEVICE HOLDS, AGAINST WHAT THE GROUP WOULD ACTUALLY DELIVER TO IT.
  //
  // Holding the group is this device's MEMORY of having joined, and it is not evidence of
  // membership: a revoke deletes the delivery rows at once while the MLS removal is committed later
  // by a remaining member, so the commit is published to a group the leaver is already unrouted
  // from and the leaver never receives it. Its local group then says "member" for ever. Re-granted,
  // it took the early return below, reconciled, asked for history, and NEVER re-joined - so nothing
  // put its rows back and it read nothing from that salon again. Measured on production 2026-08-21:
  // three minutes after a re-grant, epoch unchanged, zero rows, every message `no seed for session`.
  //
  // BOTH SIDES OF THE COMPARISON ARE NAMED BY THE SERVER'S OWN ANSWER, and the first attempt at this
  // fix was not: it asked `distributionGroupFor(scope)`, a SECOND bookkeeping layer that can lag
  // behind the tree this device actually holds, and `ensureDistributionGroup` early-returns on the
  // GROUP ID - so a device whose registration did not name the group skipped the check AND skipped
  // the join, which is the bug wearing the fix's clothes. `ref.groupId` is the one name both the
  // server and the MLS layer agree on.
  const holdsTheGroup = mlsService.getLocalGroups().includes(ref.groupId);
  const roster = ref.memberDevices;
  const serverForgotThisDevice =
    Array.isArray(roster) && !roster.includes(mlsService.getDeviceId());

  if (holdsTheGroup && !Array.isArray(roster)) {
    // NOT A NEGATIVE ANSWER, AND NOT A SILENT ONE EITHER. `undefined` means the question was never
    // put - an older delivery service, or a read that did not name the reader - so behaviour is
    // unchanged, and this line is what separates "the roster agreed" from "nobody asked".
    log(
      `[GRAINE] ${scopeLabel(scope)}: the server named no devices for this user - the group this device holds cannot be checked against the delivery roster`
    );
  }

  if (holdsTheGroup && !serverForgotThisDevice) {
    // Already in the group - but not necessarily holding anything. A device that joined while its
    // answerer was offline would never ask again if the ask lived only on the joining branch, and
    // the request is exactly what decides whether it is needed.
    await reconcileRoster(channelService, scope, log);
    await askForHistory(scope, log);
    return true;
  }

  if (holdsTheGroup) {
    // AT A LEVEL THAT ACCUSES. Reaching this means the two sides had drifted apart and a member was
    // sitting in a salon receiving nothing; the re-join below repairs it, and this line is the only
    // record that it was ever broken. Its RATE is what says whether the drift is rare or routine.
    //
    // BY GROUP ID, because the scope registration is exactly what may be wrong here: the scope form
    // resolves through it, would return null, and would leave the tree standing for the join to
    // early-return on.
    log(
      `[GRAINE] ${scopeLabel(scope)}: this device holds the distribution group but the group holds NO row for it (${roster?.length ?? 0} device(s) for this user) - the local group is stale, rejoining`
    );
    mlsService.forgetDistributionGroupById(ref.groupId);
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
