import type { ChannelService } from '$lib/services/ChannelService';
import { scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import { isGraineReady, requireGraineRuntime } from './runtime';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';

/**
 * Making a departure move the community's distribution-group epoch.
 *
 * WHAT WAS MISSING. Graine rotates a session when the distribution group's epoch changes
 * ({@link graineRotationReason} returns `roster`), and its own doc states the premise: "every
 * membership change commits to the community's distribution group and advances its epoch". Nothing
 * implemented that. A member left, their leaf stayed in the tree, the epoch did not move, the next
 * sender reused the session they already held - so a departed member's seed still opened every
 * message that followed, and their leaf would have received every seed minted afterwards.
 *
 * WHY A DIFF AND NOT AN EVENT. A departure notice reaches only the devices that are online when it
 * fires, and only one of them may commit. A durable diff between two lists needs neither: it is the
 * same answer whoever runs it, whenever they run it, and it converges to "nothing to do". The
 * server-side half of the departure - dropping the leaver's routing rows so the delivery service
 * stops handing them frames at all - is immediate and needs no client; this is the MLS half, which
 * only a member can perform.
 *
 * Protocol §4.6: remove, THEN distribute.
 */

/** What a reconciliation pass decided, in the terms its log line reports. */
export interface RosterDiff {
  /** Community members whose leaves must leave the tree. Empty on a group that already agrees. */
  strayUserIds: string[];
  /** Leaves that stay - reported so a pass that removed nothing still says what it looked at. */
  keptLeafCount: number;
}

/**
 * The user id half of a leaf identity (`userId:deviceId`).
 *
 * Split on the FIRST colon: a device id may contain one (`web-<user>-<rand>-<rand>` does not, but
 * nothing in the credential format forbids it), and a user id never does.
 */
export function userIdOfLeaf(identity: string): string {
  const colon = identity.indexOf(':');
  return (colon === -1 ? identity : identity.slice(0, colon)).toLowerCase();
}

/**
 * Which leaves no longer belong, given the tree and the roster entitled to read it.
 *
 * PURE, so the decision can be asserted without an MLS group. The roster is the authority on who
 * MAY read; the tree is the record of who CAN. A leaf whose user is absent from the roster is
 * exactly the gap between the two.
 *
 * **This device is never a stray.** It reads its own roster, so its absence from it can only mean
 * the fetch answered for another community or the membership row is mid-write - and a device that
 * removed its own leaf would leave the group it is holding open, with no way back in but a fresh
 * external join.
 */
export function diffRosterAgainstTree(input: {
  leafIdentities: string[];
  rosterUserIds: string[];
  selfUserId: string;
}): RosterDiff {
  const roster = new Set(input.rosterUserIds.map((id) => id.toLowerCase()));
  const self = input.selfUserId.toLowerCase();

  const strays = new Set<string>();
  let keptLeafCount = 0;
  for (const identity of input.leafIdentities) {
    const userId = userIdOfLeaf(identity);
    if (userId === self || roster.has(userId)) {
      keptLeafCount += 1;
      continue;
    }
    strays.add(userId);
  }

  return { strayUserIds: [...strays], keptLeafCount };
}

/**
 * Removes from `scope`'s distribution group every leaf its roster no longer names.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT, like the join it follows: a group already agreeing with its
 * roster produces no commit and no epoch change, so the next sender's session is not rotated for
 * nothing. One commit covers every stray at once - all their devices, all of them - so a departure
 * costs one epoch whatever the fleet behind it.
 *
 * **A ROSTER IT COULD NOT READ REMOVES NOBODY.** Both inputs are load-bearing and only one of them
 * can fail: a fetch that threw is not an empty community, and treating it as one would empty the
 * tree of everybody but this device. Same rule as every other destructive sweep here - absence is
 * a reason to ask again later, never to destroy.
 *
 * @returns the user ids removed; empty when there was nothing to do OR nothing could be decided.
 */
export async function reconcileDistributionGroupRoster(
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void = () => {}
): Promise<string[]> {
  if (!isGraineReady()) return [];
  const { mlsService, userId, deviceKeyB64 } = requireGraineRuntime(
    'reconcileDistributionGroupRoster'
  );

  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !mlsService.getLocalGroups().includes(groupId)) {
    // Not an error and not silent: only a member may commit, so a device that has not joined yet
    // simply is not the one that reconciles - and saying so is what distinguishes this from a pass
    // that ran and found nothing.
    log(`[GRAINE] no distribution group held for ${scopeLabel(scope)} - roster not reconciled`);
    return [];
  }

  let leafIdentities: string[];
  let rosterUserIds: string[];
  try {
    // Read together, and the tree first: a roster fetched before a leaf joined would name that
    // leaf's user as absent. Ordered this way, the worst case is a stray surviving until the next
    // pass, which is the direction this whole mechanism already fails in.
    leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
    // THE ROSTER IS THE SCOPE'S OWN, and that is the whole difference between the two groups. A
    // community's is its membership; a private salon's is the people who may open it - which is a
    // strictly smaller set, and reading the community's for a salon would re-authorise, at every
    // pass, every leaf the salon had just removed.
    rosterUserIds =
      scope.kind === 'workspace'
        ? (await channelService.listWorkspaceMembers(scope.workspaceId)).map((m) => m.userId)
        : (await channelService.listMembers(scope.channelId, 'channel')).map((m) =>
            String(m.userId)
          );
  } catch (e) {
    log(
      `[GRAINE] could not compare ${scopeLabel(scope)} with its distribution group: ${e instanceof Error ? e.message : String(e)} - nobody removed`
    );
    return [];
  }

  const diff = diffRosterAgainstTree({ leafIdentities, rosterUserIds, selfUserId: userId });
  if (diff.strayUserIds.length === 0) {
    // A CONVERGED PASS SAYS SO. The branch above claims to distinguish "this device does not hold
    // the group" from "a pass ran and found nothing" - and it could not, because this one was
    // silent. A mechanism whose success is indistinguishable from its absence can only be verified
    // by reading the database, which is how this very fix had to be checked on prod.
    log(
      `[GRAINE] ${scopeLabel(scope)} distribution group agrees with its roster - ${diff.keptLeafCount} leaf/leaves, nobody to remove`
    );
    return [];
  }

  log(
    `[GRAINE] ${scopeLabel(scope)}: ${diff.strayUserIds.length} member(s) left but still hold a leaf - removing (${diff.keptLeafCount} leaves stay)`
  );

  try {
    await mlsService.removeMember(groupId, diff.strayUserIds);
  } catch (e) {
    // Loud, and not swallowed into a boolean: until this commit lands, everyone named here can
    // still read every message the community sends. A rejected commit (another device won the
    // epoch) is the benign case and the next pass carries it; anything else is a real failure and
    // this line is the only place it is visible.
    log(
      `[GRAINE] could not remove ${diff.strayUserIds.length} departed member(s) from ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)} - they can still read it`
    );
    return [];
  }

  // Persisted here for the same reason the join is: an epoch that only ever existed in memory is
  // an epoch the next load walks back into, and the removed leaves would come back with it.
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

  log(
    `[GRAINE] ${scopeLabel(scope)} distribution group is now at epoch ${mlsService.getEpoch(groupId)} - the next send mints a session they cannot open`
  );
  return diff.strayUserIds;
}
