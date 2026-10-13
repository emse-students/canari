import type { IMlsService } from '$lib/mls-client/IMlsService';
import { diffRosterAgainstTree } from '$lib/utils/graine/rosterReconcile';
import { holdsGroupState } from './groupUsability';

/**
 * Removing from each CONVERSATION's tree every leaf its roster no longer names.
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
 * copied.
 *
 * **ONE ROSTER READ FOR EVERY GROUP, NOT ONE PER GROUP.** The rosters used to be read one group at a
 * time: 81 sequential `GET user-members` per connection, 5.0 s on the 2026-10-12 production console,
 * every one a `304`. They are now read in ONE `POST /api/mls/group-rosters` (a member is answered
 * only for the groups it is in, exactly as the single read authorizes).
 *
 * **THE BATCH ONLY SAYS WHICH GROUPS NEED NO WORK; A REMOVAL IS DECIDED ON A FRESH READ OF BOTH.**
 * Every tree is read before the rosters, so a leaf that joins afterwards is in no tree this pass
 * compares and is never a candidate. But the batch roster is as old as the start of the pass, and
 * removing by user id takes EVERY leaf of that user: a member who left before the batch read and
 * rejoined after it would lose the fresh leaf with the stale one. So a group the batch names a
 * stray in is decided again, as the per-group read always decided it - its tree, THEN its roster
 * (`GET user-members`), then the diff - right before the commit. That puts the roster-to-commit
 * window back at one round trip, and the extra read is paid only by a group that has a stray.
 *
 * **A GROUP THE BATCH DID NOT ANSWER IS NOT READ ANOTHER WAY** - a server that predates the route
 * (404), a failed chunk. Nobody is removed in it, which is the direction this mechanism already
 * fails in, and the next connection asks again. Falling back to one read per group would be a
 * second path that is silent the day the first one breaks - and on a failing network, the very
 * storm of requests the batch exists to remove. `fetchGroupRosters` warns with the server's answer.
 *
 * **NOTHING IS BROADCAST.** The leaver already sent `memberLeft` and every remaining member rendered
 * it; a `memberRemoved` notice here would tell them a second time, in the words of an eviction, that
 * somebody chose to leave.
 *
 * @returns the groups whose tree a removal changed - empty when every tree already agrees, when this
 *   device holds none of them, or when nothing could be decided.
 */
export async function removeStrayLeaves(
  mlsService: IMlsService,
  groupIds: string[],
  userId: string,
  log: (msg: string) => void
): Promise<string[]> {
  // Only a member may commit, so a device that has not joined is simply not the one that repairs
  // a group. Silent: the connection loop hands over every group the server lists.
  const held = groupIds.filter((groupId) => holdsGroupState(mlsService, groupId));
  if (held.length === 0) return [];

  // 1. Every tree FIRST (local reads), for the reason the docblock gives.
  const trees = new Map<string, string[]>();
  for (const groupId of held) {
    try {
      trees.set(groupId, await mlsService.getGroupMemberIdentities(groupId));
    } catch (e) {
      log(
        `[STRAY] ${groupId.slice(0, 8)}... could not read its tree: ${String(e)} - nobody removed`
      );
    }
  }
  if (trees.size === 0) return [];

  // 2. Every roster in one read; never throws.
  const batch = await mlsService.getGroupRosters([...trees.keys()]);
  const unanswered = [...trees.keys()].filter(
    (groupId) => !batch.rosters.has(groupId) && !batch.refused.has(groupId)
  );
  log(
    `[STRAY] compared ${trees.size} tree(s): ${batch.rosters.size} roster(s) in one read, ` +
      `${batch.refused.size} refused, ${unanswered.length} not answered (nobody removed in them)`
  );

  // 3. The batch diff, which only says where a removal MAY be owed.
  const changed: string[] = [];
  for (const [groupId, leafIdentities] of trees) {
    if (batch.refused.has(groupId)) {
      // The single read's 403: this user is not in the roster. Not an empty roster - removing
      // everybody but this device would follow from reading it as one.
      log(`[STRAY] ${groupId.slice(0, 8)}... roster refused (not a member) - nobody removed`);
      continue;
    }
    const rosterUserIds = batch.rosters.get(groupId);
    if (!rosterUserIds) continue; // not answered: counted in the line above
    const diff = diffRosterAgainstTree({ leafIdentities, rosterUserIds, selfUserId: userId });
    if (diff.strayUserIds.length === 0) continue;
    if (await removeStrays(mlsService, groupId, userId, log)) changed.push(groupId);
  }
  return changed;
}

/**
 * Decides `groupId` again on a fresh tree and a fresh roster - in that order, for the reason
 * {@link removeStrayLeaves} gives - and commits ONE Remove for every user the roster no longer
 * names; true when it landed.
 */
async function removeStrays(
  mlsService: IMlsService,
  groupId: string,
  userId: string,
  log: (msg: string) => void
): Promise<boolean> {
  let strayUserIds: string[];
  let keptLeafCount: number;
  try {
    const leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
    const rosterUserIds = (await mlsService.getGroupUserMembers(groupId)).map((m) => m.userId);
    ({ strayUserIds, keptLeafCount } = diffRosterAgainstTree({
      leafIdentities,
      rosterUserIds,
      selfUserId: userId,
    }));
  } catch (e) {
    // A fetch that threw is not an empty roster: absence is a reason to ask again, never to destroy.
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not confirm the tree against its roster: ` +
        `${String(e)} - nobody removed`
    );
    return false;
  }
  if (strayUserIds.length === 0) {
    // Another member's commit removed the leaver, or the leaver came back, since the batch read.
    log(
      `[STRAY] ${groupId.slice(0, 8)}... no stray left on a fresh read (removed by another ` +
        `member, or back in the roster) - nothing to commit`
    );
    return false;
  }

  log(
    `[STRAY] ${groupId.slice(0, 8)}... ${strayUserIds.length} member(s) left but still hold a ` +
      `leaf - removing (${keptLeafCount} leaves stay)`
  );
  try {
    await mlsService.removeMember(groupId, strayUserIds);
  } catch (e) {
    // Loud, and not swallowed into a boolean: until this commit lands, everyone named here still
    // holds key material for the conversation. A rejected commit (another member won the epoch) is
    // the benign case and the next connection carries it - anything else is a real failure, and
    // this line is the only place it is visible.
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not remove ${strayUserIds.length} departed ` +
        `member(s): ${String(e)} - their leaves stay`
    );
    return false;
  }
  log(
    `[STRAY] ${groupId.slice(0, 8)}... is now at epoch ${mlsService.getEpoch(groupId)} - the ` +
      `departed leaves are gone from the tree`
  );
  return true;
}
