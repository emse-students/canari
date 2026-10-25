import type { IMlsService } from '$lib/mls-client/IMlsService';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
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
 * **A SEAT THAT AWAITS A MEMBER'S ANSWER ADMITS NOBODY.** An invitation-link ask is a row on the
 * roster, but no accepted commit has admitted its person - so a leaf held under it (an Add decided
 * before a Decline, merged by a client the server then refused) is stray like any departed one. The
 * batch names those seats per group (`awaiting`) and the fresh read flags them
 * (`awaitingAdmission`); both are read as off the roster here.
 *
 * **AND THE LEAF OF A REVOKED DEVICE, WHOSE OWNER STAYS.** Revoking a device (`DELETE
 * mls/devices/:userId/:deviceId`) purges its routing and cannot touch a tree, so its leaf kept every
 * future epoch for whoever holds the device. The same batch read names, per group, the revoked
 * devices of the people on its roster; a leaf carrying EXACTLY one of those identities is removed
 * by device (`removeMemberDevice`), after the departures, on a fresh tree and a fresh answer. It is
 * an ALLOWLIST - a destructive control acts only on what the server states is revoked, never on a
 * leaf the routing table merely forgot (a device fresh-start looks exactly like that) - and this
 * device never removes itself: a revoked device is wiped by its own revocation path. And it is
 * staged only on the branch the server publishes (`publishedBranch.ts`): nobody asked for this
 * commit, so it must not be the one that spreads a fork.
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
  const selfIdentity = `${userId}:${mlsService.getDeviceId()}`;
  const changed: string[] = [];
  for (const [groupId, leafIdentities] of trees) {
    if (batch.refused.has(groupId)) {
      // The single read's 403: this user is not in the roster. Not an empty roster - removing
      // everybody but this device would follow from reading it as one.
      log(`[STRAY] ${groupId.slice(0, 8)}... roster refused (not a member) - nobody removed`);
      continue;
    }
    const answered = batch.rosters.get(groupId);
    if (!answered) continue; // not answered: counted in the line above
    // A seat still AWAITING a member's answer admits nobody: a leaf held under it is stray.
    const awaiting = new Set(batch.awaiting.get(groupId) ?? []);
    const rosterUserIds = answered.filter((u) => !awaiting.has(u));
    const diff = diffRosterAgainstTree({ leafIdentities, rosterUserIds, selfUserId: userId });
    const revoked = revokedLeavesIn({
      leafIdentities,
      revokedIdentities: batch.revoked.get(groupId) ?? [],
      selfIdentity,
    });
    if (revoked.selfListed) {
      log(
        `[STRAY] ${groupId.slice(0, 8)}... THIS device is listed as revoked - its own leaf is left ` +
          'to the revocation path, never removed by itself'
      );
    }
    let changedHere = false;
    if (diff.strayUserIds.length > 0 && (await removeStrays(mlsService, groupId, userId, log))) {
      changedHere = true;
    }
    if (
      revoked.identities.length > 0 &&
      (await removeRevokedLeaves(mlsService, groupId, selfIdentity, log))
    ) {
      changedHere = true;
    }
    if (changedHere) changed.push(groupId);
  }
  return changed;
}

/**
 * TAKES BACK THE LEAVES A MERGED ADD GAVE PEOPLE THE SERVER DID NOT ADMIT, NOW.
 *
 * The member-add call answered `MemberNotAdmittedError`: the commit was accepted, but a Decline or a
 * departure the server recorded before the Add was decided meant it admitted nobody named in
 * `users`. Their leaves hold no seat - the very shape {@link removeStrayLeaves} collects - so this is
 * that collector, run on the one group right away rather than at the next connection: until it
 * lands, a person nobody admitted holds the group's keys. The caller withholds their Welcome.
 *
 * @returns whether a removal landed; false is logged loudly, and the next connection retries.
 */
export async function takeBackUnadmittedLeaves(
  mlsService: IMlsService,
  groupId: string,
  selfUserId: string,
  users: string[],
  tag: string,
  log: (msg: string) => void
): Promise<boolean> {
  const short = groupId.slice(0, 8);
  log(
    `${tag} ${users.join(', ')} not admitted by the server in ${short}... (a Decline or a departure ` +
      'came before this Add was decided) - Welcome withheld, removing the leaves the commit gave them'
  );
  const swept = await removeStrayLeaves(mlsService, [groupId], selfUserId, log);
  if (swept.length > 0) {
    log(`${tag} the unadmitted leaves are gone from ${short}...`);
    return true;
  }
  log(
    `${tag} [WARN] the unadmitted leaves of ${short}... were NOT removed now - the stray collector ` +
      'retries at the next connection'
  );
  return false;
}

/**
 * Which leaves of a tree belong to a device the server names as revoked. PURE.
 *
 * An ALLOWLIST: a leaf is a candidate only when its WHOLE identity (`userId:deviceId`) is in the
 * revoked list - device ids are client-generated, so two users can hold the same one. This device
 * is never a candidate: it is reported (`selfListed`) and left to its own revocation path, which
 * wipes it - a device that removed its own leaf would only strand the group it holds.
 */
export function revokedLeavesIn(input: {
  leafIdentities: string[];
  revokedIdentities: string[];
  selfIdentity: string;
}): { identities: string[]; selfListed: boolean } {
  const revoked = new Set(input.revokedIdentities);
  const identities = input.leafIdentities.filter(
    (identity) => identity !== input.selfIdentity && revoked.has(identity)
  );
  return {
    identities: [...new Set(identities)],
    selfListed:
      revoked.has(input.selfIdentity) && input.leafIdentities.includes(input.selfIdentity),
  };
}

/**
 * Decides `groupId` again on a fresh tree and a fresh revocation answer - in that order, for the
 * reason {@link removeStrayLeaves} gives - and commits ONE Remove for every revoked device still in
 * the tree; true when it landed. A fresh answer that does not name the group removes nobody.
 */
async function removeRevokedLeaves(
  mlsService: IMlsService,
  groupId: string,
  selfIdentity: string,
  log: (msg: string) => void
): Promise<boolean> {
  const short = groupId.slice(0, 8);
  let identities: string[];
  try {
    const leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
    const fresh = await mlsService.getGroupRosters([groupId]);
    ({ identities } = revokedLeavesIn({
      leafIdentities,
      revokedIdentities: fresh.revoked.get(groupId) ?? [],
      selfIdentity,
    }));
  } catch (e) {
    log(
      `[STRAY] ${short}... could not confirm the revoked leaves on a fresh read: ${String(e)} - ` +
        'nobody removed'
    );
    return false;
  }
  if (identities.length === 0) {
    log(
      `[STRAY] ${short}... no revoked leaf left on a fresh read (removed by another member, or no ` +
        'longer named) - nothing to commit'
    );
    return false;
  }

  log(`[STRAY] ${short}... ${identities.length} revoked device(s) still hold a leaf - removing`);
  try {
    await mlsService.removeMemberDevice(groupId, identities);
  } catch (e) {
    if (e instanceof UnpublishedBranchError) {
      // Nothing was staged: this device's state is not the branch the server publishes, and a
      // removal from it would spread that branch. A `diverged` one was handed to the recovery
      // ladder where it was thrown; the next connection after the repair decides again.
      log(
        `[STRAY] ${short}... ${identities.length} revoked device(s) NOT removed: the published base ` +
          `cannot vouch for this device's state (${e.reason}) - nothing staged`
      );
      return false;
    }
    // Loud for the reason `removeStrays` gives: until this lands, the revoked device can still
    // read every new epoch. The next connection decides again.
    const named = new Set(identities);
    await reportFailedRemoval(
      mlsService,
      groupId,
      `${identities.length} revoked device(s)`,
      (leaf) => named.has(leaf),
      e,
      log
    );
    return false;
  }
  log(
    `[STRAY] ${short}... is now at epoch ${mlsService.getEpoch(groupId)} - the revoked leaves are ` +
      'gone from the tree'
  );
  return true;
}

/**
 * Says what a REFUSED removal left, read from the tree after the refusal rather than assumed.
 *
 * Two members' collectors race on the same leaf, and the loser's commit is refused precisely
 * because the winner's removed it: "their leaves stay" would then be false, and the line its reader
 * learns to skip. The tree is read again, and the line names what is actually still there.
 */
async function reportFailedRemoval(
  mlsService: IMlsService,
  groupId: string,
  what: string,
  isTarget: (leafIdentity: string) => boolean,
  error: unknown,
  log: (msg: string) => void
): Promise<void> {
  const short = groupId.slice(0, 8);
  let left: number;
  try {
    left = (await mlsService.getGroupMemberIdentities(groupId)).filter(isTarget).length;
  } catch (e) {
    log(
      `[STRAY] ${short}... could not remove ${what}: ${String(error)} - and the tree could not be ` +
        `read again (${String(e)}), so whether their leaves stay is unknown`
    );
    return;
  }
  log(
    left === 0
      ? `[STRAY] ${short}... removal of ${what} refused (${String(error)}), and their leaves are ` +
          'already gone from the tree - another member removed them first'
      : `[STRAY] ${short}... could not remove ${what}: ${String(error)} - ${left} of their ` +
          'leaves stay'
  );
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
    const rosterUserIds = (await mlsService.getGroupUserMembers(groupId))
      .filter((m) => m.awaitingAdmission !== true)
      .map((m) => m.userId);
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
    const departed = new Set(strayUserIds);
    await reportFailedRemoval(
      mlsService,
      groupId,
      `${strayUserIds.length} departed member(s)`,
      (leaf) => departed.has(leaf.slice(0, Math.max(0, leaf.indexOf(':')))),
      e,
      log
    );
    return false;
  }
  log(
    `[STRAY] ${groupId.slice(0, 8)}... is now at epoch ${mlsService.getEpoch(groupId)} - the ` +
      `departed leaves are gone from the tree`
  );
  return true;
}
