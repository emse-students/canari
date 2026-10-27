import type { ChannelService } from '$lib/services/ChannelService';
import { scopeKey, scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import { isGraineReady, requireGraineRuntime } from './runtime';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { canonicalUserId, userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { observeAdmissionState } from './admissionGate';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import { CommitOutcomeUnknownError } from '$lib/mls-client/commitSubmission';

/**
 * Making a departure move the community's distribution-group epoch.
 *
 * WHAT WAS MISSING. Graine rotated a session when the distribution group's epoch changed (since
 * 2026-10-22, when a Remove is merged: `graineOutboundVerdict`), and its doc stated the premise: "every
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
  // The SAME canonical form as the leaf's user half (`userIdOfLeaf`): two lowercasings that
  // disagreed on one id would read a member as a stray, and this diff decides a removal.
  const roster = new Set(input.rosterUserIds.map(canonicalUserId));
  const self = canonicalUserId(input.selfUserId);

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
 * **ONE PASS PER SCOPE AT A TIME, AND A CALLER ARRIVING DURING ONE GETS THE NEXT.** Since
 * 2026-10-27 the actor of a removal runs a pass the moment the server accepts it
 * (`commitRemoval.ts`), so a pass can now start while a load's pass is reading or committing. Two
 * passes reading one tree would both decide the same Remove, and the loser's refusal would be
 * logged as a removal that failed. So a pass waits for the one running on its scope - which may
 * have read the roster BEFORE the caller's server write, so sharing it would not do - and callers
 * that arrive while a pass is still WAITING share that one, since it has read nothing yet. A shared
 * pass logs through EVERY caller's `log`, so each caller's trail shows the pass it got.
 *
 * **TERMINATION IS THE TRANSPORTS' OWN, NOT A TIMER HERE.** A pass awaits a local tree read, the
 * roster read and the base read (`apiFetch`: a response-head deadline that throws the typed
 * `RequestDeadlineError`), at most one commit (submitted under the MLS lock-hold budget, which
 * aborts a hung submission as a typed failure) and a local persist. Each therefore settles - a
 * failure is caught and logged by the pass - and the lane is released whatever the outcome: a
 * rejected pass is swallowed by the tail, never left holding the scope. A timer on the lane would
 * only race those deadlines and abandon a commit whose fate is unknown.
 *
 * @returns the user ids removed; empty when there was nothing to do OR nothing could be decided.
 */
export function reconcileDistributionGroupRoster(
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void = () => {}
): Promise<string[]> {
  const pass = reconcileDistributionGroupRosterReported(channelService, scope, log);
  // A SHARED pass is the same promise for every caller that shares it, here as in the report.
  let removed = removedByPass.get(pass);
  if (!removed) {
    removed = pass.then((report) => report.removedUserIds);
    removedByPass.set(pass, removed);
  }
  return removed;
}

/** The removed-ids view of each pass, so callers sharing a pass share one promise. */
const removedByPass = new WeakMap<Promise<RosterPassReport>, Promise<string[]>>();

/**
 * What one roster pass did, for a caller that must know more than who it removed: the actor of a
 * removal, which releases a Remove it claimed only on a PROOF that it did not commit it
 * (`commitRemoval.ts`).
 */
export interface RosterPassReport {
  /** The user ids this pass removed. */
  removedUserIds: string[];
  /**
   * The users holding a leaf of the tree as this pass LEFT it, read inside the lane; `null` when
   * that is unknown - a commit of this pass whose outcome is unknown (it may yet land), a tree
   * that could not be read, or no group held. A user named here is one this pass knows it did not
   * remove: nothing was staged, or the commit was definitively refused.
   */
  heldUserIds: string[] | null;
}

/** {@link reconcileDistributionGroupRoster}, with the pass's {@link RosterPassReport}. Same lane. */
export function reconcileDistributionGroupRosterReported(
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void = () => {}
): Promise<RosterPassReport> {
  const key = scopeKey(scope);
  const lane = passes.get(key) ?? { tail: Promise.resolve(), waiting: null };
  if (lane.waiting) {
    log(
      `[GRAINE] ${scopeLabel(scope)}: a roster pass is already waiting to read - sharing it rather than queuing another`
    );
    lane.waiting.logs.push(log);
    return lane.waiting.pass;
  }
  const logs = [log];
  const fanOut = (message: string) => {
    for (const each of logs) each(message);
  };
  const pass: Promise<RosterPassReport> = lane.tail.then(() => {
    // Started: it reads from here on, so a caller arriving now needs the pass after it.
    if (lane.waiting?.pass === pass) lane.waiting = null;
    return reconcileOnce(channelService, scope, fanOut);
  });
  lane.waiting = { pass, logs };
  const tail = pass.then(
    () => undefined,
    () => undefined
  );
  lane.tail = tail;
  passes.set(key, lane);
  void tail.then(() => {
    if (passes.get(key) === lane && lane.tail === tail) passes.delete(key);
  });
  return pass;
}

/**
 * Roster passes by scope key: the tail every new pass starts after, and the pass that has not
 * started reading yet (shared by whoever arrives before it does). Module-level because the callers
 * - a load, a join, the actor of a removal - live in different modules; it holds promises for the
 * duration of the passes only, so logging out leaves nothing behind.
 */
const passes = new Map<
  string,
  {
    tail: Promise<void>;
    waiting: { pass: Promise<RosterPassReport>; logs: Array<(message: string) => void> } | null;
  }
>();

/** One pass of {@link reconcileDistributionGroupRoster}, unserialised. Never called directly. */
async function reconcileOnce(
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void
): Promise<RosterPassReport> {
  const unknown: RosterPassReport = { removedUserIds: [], heldUserIds: null };
  if (!isGraineReady()) return unknown;
  const { mlsService, userId, deviceKey } = requireGraineRuntime(
    'reconcileDistributionGroupRoster'
  );

  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !holdsGroupState(mlsService, groupId)) {
    // Not an error and not silent: only a member may commit, so a device that has not joined yet
    // simply is not the one that reconciles - and saying so is what distinguishes this from a pass
    // that ran and found nothing.
    log(`[GRAINE] no distribution group held for ${scopeLabel(scope)} - roster not reconciled`);
    return unknown;
  }

  let leafIdentities: string[] | null = null;
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
    if (scope.kind === 'workspace') {
      const rows = await channelService.listWorkspaceMembers(scope.workspaceId);
      rosterUserIds = rows.map((m) => m.userId);
      await recordAdmissionState(scope.workspaceId, groupId, rows, log);
    } else {
      rosterUserIds = (await channelService.listMembers(scope.channelId, 'channel')).map((m) =>
        String(m.userId)
      );
    }
  } catch (e) {
    log(
      `[GRAINE] could not compare ${scopeLabel(scope)} with its distribution group: ${String(e)} - nobody removed`
    );
    // Nothing was staged: the tree as read (if it was) is the tree this pass leaves.
    return { removedUserIds: [], heldUserIds: leafIdentities ? leafUsers(leafIdentities) : null };
  }

  const tree = leafIdentities as string[];
  const diff = diffRosterAgainstTree({ leafIdentities: tree, rosterUserIds, selfUserId: userId });
  if (diff.strayUserIds.length === 0) {
    // A CONVERGED PASS SAYS SO. The branch above claims to distinguish "this device does not hold
    // the group" from "a pass ran and found nothing" - and it could not, because this one was
    // silent. A mechanism whose success is indistinguishable from its absence can only be verified
    // by reading the database, which is how this very fix had to be checked on prod.
    log(
      `[GRAINE] ${scopeLabel(scope)} distribution group agrees with its roster - ${diff.keptLeafCount} leaf/leaves, nobody to remove`
    );
    return { removedUserIds: [], heldUserIds: leafUsers(tree) };
  }

  log(
    `[GRAINE] ${scopeLabel(scope)}: ${diff.strayUserIds.length} member(s) left but still hold a leaf - removing (${diff.keptLeafCount} leaves stay)`
  );

  try {
    // A commit the DIFF decided, nobody asked for: staged only on the branch the server publishes
    // (`publishedBranch.ts`), like the conversation stray sweep - a forked device must not be the
    // one that removes anybody from a key group.
    await mlsService.removeDepartedMembers(groupId, diff.strayUserIds);
  } catch (e) {
    if (e instanceof UnpublishedBranchError) {
      // NOT a refusal: nothing was staged. A `diverged` state was handed to the recovery ladder
      // where it was thrown; a stale base is republished by the next ordinary read of the scope.
      log(
        `[GRAINE] ${diff.strayUserIds.length} departed member(s) NOT removed from ${scopeLabel(scope)}: the published base cannot vouch for this device's state (${e.reason}) - nothing staged`
      );
      return { removedUserIds: [], heldUserIds: leafUsers(tree) };
    }
    // Loud, and not swallowed into a boolean: until this commit lands, everyone named here can
    // still read every message the community sends - IF they are still in the tree. A refused
    // commit is usually another device having removed them first (the actor and a load, or two
    // elected devices), so the tree is read AGAIN and the line says what is actually left.
    return {
      removedUserIds: [],
      heldUserIds: await reportRefusedRemoval(
        mlsService,
        groupId,
        scope,
        diff.strayUserIds,
        e,
        log
      ),
    };
  }

  // Persisted here for the same reason the join is: an epoch that only ever existed in memory is
  // an epoch the next load walks back into, and the removed leaves would come back with it.
  await persistMlsStateAfterMutation(mlsService, userId, deviceKey(), log);

  log(
    `[GRAINE] ${scopeLabel(scope)} distribution group is now at epoch ${mlsService.getEpoch(groupId)} - the next send mints a session they cannot open`
  );
  const removed = new Set(diff.strayUserIds);
  return {
    removedUserIds: diff.strayUserIds,
    heldUserIds: leafUsers(tree).filter((u) => !removed.has(u)),
  };
}

/** The distinct canonical users holding a leaf of `leafIdentities`. PURE. */
function leafUsers(leafIdentities: string[]): string[] {
  return [...new Set(leafIdentities.map(userIdOfLeaf).filter((u): u is string => Boolean(u)))];
}

/**
 * Says what a failed departed-member removal LEFT, read from the tree after the failure rather than
 * assumed - the rule `strayLeaves.ts` follows for conversations. "They can still read it" about
 * members another device already removed is false, and a line its reader learns to skip.
 *
 * A commit whose OUTCOME IS UNKNOWN (`CommitOutcomeUnknownError`) is not a refusal: it may yet land,
 * so it is said as such and the tree it leaves is unknown (`null`).
 *
 * @returns the users holding a leaf after the failure, or `null` when that is unknown.
 */
async function reportRefusedRemoval(
  mlsService: { getGroupMemberIdentities(groupId: string): Promise<string[]> },
  groupId: string,
  scope: DistributionScope,
  strayUserIds: string[],
  error: unknown,
  log: (message: string) => void
): Promise<string[] | null> {
  const label = scopeLabel(scope);
  const strays = new Set(strayUserIds.map(canonicalUserId));
  if (error instanceof CommitOutcomeUnknownError) {
    log(
      `[GRAINE] the removal of ${strays.size} departed member(s) from ${label} was sent and NOT answered (${String(error)}) - it may yet land; the next resubmission decides`
    );
    return null;
  }
  let held: string[];
  let left: number;
  try {
    held = leafUsers(await mlsService.getGroupMemberIdentities(groupId));
    left = held.filter((u) => strays.has(u)).length;
  } catch (e) {
    log(
      `[GRAINE] could not remove ${strays.size} departed member(s) from ${label}: ${String(error)} - and the tree could not be read again (${String(e)}), so whether they can still read it is unknown`
    );
    return null;
  }
  log(
    left === 0
      ? `[GRAINE] removal of ${strays.size} departed member(s) from ${label} refused (${String(error)}), and they are already gone from the tree - another device removed them first`
      : `[GRAINE] could not remove ${strays.size} departed member(s) from ${label}: ${String(error)} - ${left} of them still hold a leaf and can still read it`
  );
  return held;
}

/**
 * The community sync is where the admission ledger's ROOTS are fixed (channel-encryption section
 * 25), at the first one after the proof existed. Removals are not recorded here: the MLS layer
 * records them at merge time (`removalEpochs`). Never fails the reconciliation -
 * a ledger left unfed only means the next sync or the next check records it - but says so.
 */
async function recordAdmissionState(
  workspaceId: string,
  groupId: string,
  rows: Parameters<typeof observeAdmissionState>[2],
  log: (message: string) => void
): Promise<void> {
  try {
    await observeAdmissionState(workspaceId, groupId, rows);
  } catch (e) {
    log(
      `[GRAINE] admission state of community ${workspaceId.slice(0, 8)} not recorded at this sync: ${String(e)}`
    );
  }
}
