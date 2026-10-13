import type { IMlsService } from '$lib/mls-client/IMlsService';
import { userIdOfLeaf } from '$lib/mls-client/leafIdentity';
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
 * only for the groups it is in, exactly as the single read authorizes). A group that read did not
 * answer - a server that predates the route, a failed chunk - is read on its own, which is the path
 * every group took before.
 *
 * **EVERY TREE IS READ BEFORE THE ROSTERS, AND THAT ORDER IS WHAT MAKES THE BATCH SOUND.** A roster
 * read before a leaf joined would name that leaf's user as absent, and removing them would evict a
 * member who just arrived. With every tree read first, a leaf that joins afterwards is in no tree
 * this pass compares, so it can never be a candidate - the worst case stays a stray surviving until
 * the next connection, the direction this mechanism already fails in. The batch WIDENS the window
 * between the roster read and the commit (from one round trip to the length of the pass); the only
 * new exposure is a member who leaves AND rejoins inside it, whose fresh leaf would go with the old
 * one - the per-group read had the same race over one round trip, and their own device heals it
 * through the ordinary re-add. Right before a commit the tree is read again and only users still
 * holding a leaf are named, so a stray another member already removed is not removed twice.
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
      `${batch.refused.size} refused, ${unanswered.length} read on their own`
  );

  // 3. The diff, and a removal where one is owed.
  const changed: string[] = [];
  for (const [groupId, leafIdentities] of trees) {
    if (batch.refused.has(groupId)) {
      // The single read's 403: this user is not in the roster. Not an empty roster - removing
      // everybody but this device would follow from reading it as one.
      log(`[STRAY] ${groupId.slice(0, 8)}... roster refused (not a member) - nobody removed`);
      continue;
    }
    let rosterUserIds = batch.rosters.get(groupId);
    if (!rosterUserIds) {
      try {
        rosterUserIds = (await mlsService.getGroupUserMembers(groupId)).map((m) => m.userId);
      } catch (e) {
        log(
          `[STRAY] ${groupId.slice(0, 8)}... could not compare the tree with its roster: ` +
            `${String(e)} - nobody removed`
        );
        continue;
      }
    }
    const diff = diffRosterAgainstTree({ leafIdentities, rosterUserIds, selfUserId: userId });
    if (diff.strayUserIds.length === 0) continue;
    if (await removeStrays(mlsService, groupId, diff.strayUserIds, diff.keptLeafCount, log)) {
      changed.push(groupId);
    }
  }
  return changed;
}

/** Commits ONE Remove for `strays` still holding a leaf in `groupId`; true when it landed. */
async function removeStrays(
  mlsService: IMlsService,
  groupId: string,
  strays: string[],
  keptLeafCount: number,
  log: (msg: string) => void
): Promise<boolean> {
  // Re-read here: the tree compared above may have moved since (another member's commit removing
  // the same leaver). Only users still holding a leaf are named.
  let stillThere: string[];
  try {
    const now = new Set((await mlsService.getGroupMemberIdentities(groupId)).map(userIdOfLeaf));
    stillThere = strays.filter((u) => now.has(u.toLowerCase()));
  } catch (e) {
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not re-read its tree: ${String(e)} - nobody removed`
    );
    return false;
  }
  if (stillThere.length === 0) {
    log(
      `[STRAY] ${groupId.slice(0, 8)}... the departed leaves are already gone - nothing to commit`
    );
    return false;
  }

  log(
    `[STRAY] ${groupId.slice(0, 8)}... ${stillThere.length} member(s) left but still hold a ` +
      `leaf - removing (${keptLeafCount} leaves stay)`
  );
  try {
    await mlsService.removeMember(groupId, stillThere);
  } catch (e) {
    // Loud, and not swallowed into a boolean: until this commit lands, everyone named here still
    // holds key material for the conversation. A rejected commit (another member won the epoch) is
    // the benign case and the next connection carries it - anything else is a real failure, and
    // this line is the only place it is visible.
    log(
      `[STRAY] ${groupId.slice(0, 8)}... could not remove ${stillThere.length} departed ` +
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
