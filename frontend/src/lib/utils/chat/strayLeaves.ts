import type { IMlsService } from '$lib/mls-client/IMlsService';
import { diffRosterAgainstTree } from '$lib/utils/graine/rosterReconcile';
import { holdsGroupState } from './groupUsability';

/**
 * Removing from a CONVERSATION's tree every leaf its roster no longer names.
 *
 * **LEAVING A CONVERSATION STAGES NOTHING FOR THE LEAVER'S OWN LEAF, AND IT CANNOT.**
 * `leaveGroupAndBroadcast` says so in as many words: it announces `memberLeft`, drops the server
 * registry rows, forgets its local state - and generates no Remove commit, because a departing
 * member is exactly the party that cannot commit its own eviction. So the leaf stays in every
 * remaining member's tree, holding key material for a conversation its owner has walked out of, and
 * nothing anywhere collects it.
 *
 * **THE REPAIR ALREADY EXISTED ONE SCOPE OVER.** `reconcileDistributionGroupRoster` is this, for a
 * community's distribution group, and its doc carries the whole design - why a durable DIFF rather
 * than a departure EVENT ("a departure notice reaches only the devices that are online when it
 * fires, and only one of them may commit"), why the roster is the authority on who MAY read while
 * the tree records who CAN, and why a fetch that threw is not an empty roster. Only the two reads
 * differ, so only the two reads are written again here: `diffRosterAgainstTree` is imported, not
 * copied. This is the same shape as the stale-base repair next to it in `initializeConnection`,
 * which was also "distribution groups only" until three of the four groups it would have fixed
 * turned out to be conversations.
 *
 * **THE COST IS ONE HTTP CALL PER HELD GROUP PER CONNECTION, and it is paid deliberately.** The
 * epochs the stale-base repair needs travel on the group list already; a roster does not, and no
 * weaker discriminator is honest - a member count matches for a group that lost one member and
 * gained another, which is precisely a tree with a stray in it. A count would turn a repair into a
 * heuristic that misses. If the call ever costs too much the answer is a bulk roster endpoint, not
 * a guess.
 *
 * **NOTHING IS BROADCAST.** The leaver already sent `memberLeft` and every remaining member rendered
 * it; a `memberRemoved` notice here would tell them a second time, in the words of an eviction, that
 * somebody chose to leave.
 *
 * @returns the user ids removed - empty when the tree already agrees, when this device does not
 *   hold it, or when nothing could be decided.
 */
export async function removeStrayLeaves(
  mlsService: IMlsService,
  groupId: string,
  userId: string,
  log: (msg: string) => void
): Promise<string[]> {
  // Only a member may commit, so a device that has not joined is simply not the one that repairs
  // this. Silent: this loop walks every group the server lists and most of them are not held.
  if (!holdsGroupState(mlsService, groupId)) return [];

  let leafIdentities: string[];
  let rosterUserIds: string[];
  try {
    // The tree FIRST, for the reason the distribution version gives: a roster read before a leaf
    // joined would name that leaf's user as absent. This way the worst case is a stray surviving
    // until the next connection, which is the direction this mechanism already fails in.
    leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
    rosterUserIds = (await mlsService.getGroupUserMembers(groupId)).map((m) => m.userId);
  } catch (e) {
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not compare the tree with its roster: ` +
        `${e instanceof Error ? e.message : String(e)} - nobody removed`
    );
    return [];
  }

  const diff = diffRosterAgainstTree({ leafIdentities, rosterUserIds, selfUserId: userId });
  if (diff.strayUserIds.length === 0) return [];

  log(
    `[STRAY] ${groupId.slice(0, 8)}... ${diff.strayUserIds.length} member(s) left but still hold a ` +
      `leaf - removing (${diff.keptLeafCount} leaves stay)`
  );

  try {
    await mlsService.removeMember(groupId, diff.strayUserIds);
  } catch (e) {
    // Loud, and not swallowed into a boolean: until this commit lands, everyone named here still
    // holds key material for the conversation. A rejected commit (another member won the epoch) is
    // the benign case and the next connection carries it - anything else is a real failure, and
    // this line is the only place it is visible.
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not remove ${diff.strayUserIds.length} departed ` +
        `member(s): ${e instanceof Error ? e.message : String(e)} - their leaves stay`
    );
    return [];
  }

  log(
    `[STRAY] ${groupId.slice(0, 8)}... is now at epoch ${mlsService.getEpoch(groupId)} - the ` +
      `departed leaves are gone from the tree`
  );
  return diff.strayUserIds;
}
