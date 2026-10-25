import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import { forgetMlsGroupIfPresent } from './groupActions';
import { reconcileAbsentLocalGroup, type AbsentLocalGroupVerdict } from './groupLifecycle';

/**
 * The two reads a group sweep compares, taken in the ONE order that is sound, plus the verdict on
 * whether the comparison may destroy anything.
 *
 * WHY THIS IS A TYPE AND NOT TWO CALLS. Two sweeps walk this exact comparison - the connection sync
 * (`syncConnectionAfterWsOpen`) and discovery (`discoverMissingGroups`) - and the MLS audit's `D5`
 * names them as one duplicate. They were not a duplicate of one decision: they were two copies that
 * had drifted apart on every axis the comparison has, and a comment in the first ASSERTED that the
 * second agreed with it while the code said otherwise. Four divergences, measured against `main` on
 * 2026-09-14:
 *
 *  1. **The empty-list guard existed on ONE side.** The sync refuses to read absence off a list that
 *     came back empty while this device holds trees; discovery purged on `serverFetchSucceeded`
 *     alone. See {@link GroupSweepSnapshot.absenceIsEvidence} - this is the one that destroys state.
 *  2. **Only discovery de-duplicated the rows.** The sync iterated the raw response, so a server
 *     that transiently repeated a row drove `onGroupMissing` and the stale-base repair twice for it.
 *  3. **The failed fetch was logged on one side and swallowed on the other** (`catch {}`).
 *  4. **The removal was logged with a different sentence on each side**, and discovery's did not
 *     carry the `reason` the decision returned - the one sentence a reader reaches for when a group
 *     has been forgotten and nobody knows why.
 *
 * THE ORDER IS THE WHOLE POINT, AND IT IS WHY THE CAPTURE LIVES IN HERE RATHER THAN IN A CALLER.
 * The sweep destroys the MLS tree of any local group the server did not list, which is only sound
 * for groups that already existed when the server was asked. Reading the local set AFTER the awaited
 * fetch - which BOTH sites did, and both were fixed separately, hours apart, on 2026-08-30 - puts
 * every group created DURING the fetch into a comparison against a snapshot that could not possibly
 * contain it, and the sweep then deletes the only copy of a group that is milliseconds old.
 * Measured on the creator's own console during HEAL-REVOKE-7: `create_group: 8868be1c` at 44.572,
 * `add_members_bulk` at 44.830, the sweep at 44.863, and the creator could not find its own group
 * 31 ms later - it answered `welcome_request` with `Group not found` for the next twenty minutes.
 * A caller cannot take the two reads in the wrong order any more, because a caller no longer takes
 * them.
 *
 * Capturing early can only ever SPARE a group - one that became absent during the fetch is swept on
 * the next pass - so it can destroy nothing the wrong order did not.
 */
export interface GroupSweepSnapshot {
  /** WASM group ids held by this device, captured BEFORE the server was asked. */
  localGroups: Set<string>;
  /** Server rows, de-duplicated by `groupId` (first occurrence wins); empty when the fetch failed. */
  serverGroups: UserGroupRow[];
  /** `serverGroups` as a lookup. */
  serverGroupIds: Set<string>;
  /** The fetch returned at all. False means the list is not even a list. */
  fetchOk: boolean;
  /**
   * May absence from {@link GroupSweepSnapshot.serverGroupIds} be read as evidence that a group is
   * gone?
   *
   * ABSENCE FROM THE LIST IS A REASON TO ASK, NEVER A REASON TO DESTROY - and this flag is about
   * the list itself rather than about any one group. Two shapes make it worthless:
   *  - the fetch failed (a 502 during a redeploy): every group reads absent;
   *  - it came back EMPTY while this device holds CONVERSATION trees: an account with such trees
   *    always has `dm_group_members` rows server-side, and leaving or deleting a group drops the
   *    local tree in the same breath (`leaveGroupAndBroadcast`, `deleteGroupAndBroadcast`), so
   *    "local trees, no server rows" is a transient answer rather than a state a user can reach.
   *    A Graine key-group tree does NOT count: the list never carries key groups (they hold no
   *    `dm_group_members` row), so any community member's device holds trees the list cannot name,
   *    and counting them made an honestly empty list - a joiner whose only ask was declined -
   *    unbelievable for ever (review of #2493).
   *    THE PRICE, TAKEN DELIBERATELY: a device whose only conversation trees are none at all - a
   *    member whose only conversations are pending link asks - now believes a transient `200 []`
   *    too. Its ask row is then removed locally though the seat stands; the cost is a second ask
   *    from the link, and no history, since a never-admitted row holds none.
   */
  absenceIsEvidence: boolean;
  /** Why the list may not be used, in the words the skip is logged with; `null` when it may. */
  unusableReason: string | null;
}

/**
 * Reads this device's MLS groups and the server's conversation list, in that order, and says
 * whether the two may be compared destructively. See {@link GroupSweepSnapshot}.
 *
 * The fetch failing is NOT thrown here: both callers have work to do without the list (device
 * invitations, pending placeholders), so the failure is logged and carried in the snapshot instead.
 * Nothing downstream may purge on it - `absenceIsEvidence` is what says so.
 */
export async function readGroupSweepSnapshot(
  mlsService: Pick<IMlsService, 'getLocalGroups' | 'getUserGroups' | 'isDistributionGroup'>,
  userId: string,
  log: (msg: string) => void
): Promise<GroupSweepSnapshot> {
  const localGroups = new Set(mlsService.getLocalGroups());

  let rows: UserGroupRow[] = [];
  let fetchOk = false;
  try {
    rows = await mlsService.getUserGroups(userId);
    fetchOk = true;
  } catch (e) {
    log(`[SYNC] Failed to fetch user groups: ${e}`);
    console.error('[SYNC] Failed to fetch user groups:', e);
  }

  // Some backends can transiently return duplicates; keep the FIRST occurrence by groupId.
  //
  // Discovery's copy said "keep first occurrence" in a comment and kept the LAST - `new Map(rows)`
  // lets a later entry overwrite an earlier one - so the comment was wrong for as long as it
  // existed. It decides which `name`, `activeEpoch` and `baseEpoch` the rest of the sweep reasons
  // about, and the stale-base repair reads that pair.
  const byId = new Map<string, UserGroupRow>();
  for (const row of rows) if (!byId.has(row.groupId)) byId.set(row.groupId, row);
  const serverGroups = [...byId.values()];
  const serverGroupIds = new Set(serverGroups.map((g) => g.groupId));

  let unusableReason: string | null = null;
  if (!fetchOk) {
    unusableReason = 'the server list could not be fetched';
  } else if (serverGroups.length === 0) {
    // Only the trees the list could name are evidence against it - see `absenceIsEvidence`.
    const conversationTrees = [...localGroups].filter((id) => !mlsService.isDistributionGroup(id));
    if (conversationTrees.length > 0) {
      unusableReason = `the server list is empty while this device holds ${conversationTrees.length} conversation group(s)`;
    }
  }

  return {
    localGroups,
    serverGroups,
    serverGroupIds,
    fetchOk,
    absenceIsEvidence: unusableReason === null,
    unusableReason,
  };
}

/**
 * What the server said about each absent local group during ONE connection pass, so the two sweeps
 * of that pass ask once between them.
 *
 * WHY IT EXISTS. A connection runs the sync sweep and then discovery, and each asked
 * `GET /api/mls/groups/<id>` for every key-distribution group the conversation list leaves out -
 * the same eight groups, the same `keep`, twice in four seconds, sixteen serial requests and sixteen
 * `[SYNC] WASM kept` lines on every connection (Pixel 6a, prod 1.2.7, 2026-10-14: 344 such lines,
 * 43 per group, in two hours).
 *
 * ONE PASS AND NEVER LONGER, which is the line {@link reconcileAbsentLocalGroup} draws: the row is
 * read every time because a group can stop existing at any point in a session. A pass is created
 * by the connection sync and handed to the discovery that follows it; a later pass (a reconnect,
 * the 35 s retry) starts without one and asks again. Created per pass, so it is bounded by the
 * groups of one sweep and dies with it - no clock decides how long an answer is believed.
 */
export type AbsentGroupVerdicts = Map<string, AbsentLocalGroupVerdict>;

/**
 * Destroys the local MLS state of every group in the snapshot the server did not name, and returns
 * whether anything was destroyed - the caller checkpoints on that.
 *
 * IT DECIDES NOTHING ITSELF. Which groups may be forgotten is `reconcileAbsentLocalGroup`'s
 * question, and it is asked per group because the answer needs the `dm_groups` row: a community's
 * or a salon's key-distribution group is excluded from `getUserGroups` by construction, and two
 * reconcilers reading that list as "every group this device may hold" forgot it on every single
 * connection (WP-GRAINE-1, prod 2026-08-19). What THIS function owns is everything that was
 * duplicated ABOVE that decision: the guard, the iteration, and the words the outcome is logged in.
 *
 * The skip is logged rather than silent, and only when there was something to skip: a device with no
 * local groups has nothing at risk, and a line per connection saying so is noise.
 *
 * @param verdicts this pass's answers ({@link AbsentGroupVerdicts}). A group already answered
 *   `keep` in it is kept without a second request; one not in it is asked and recorded. Absent for a
 *   sweep that is a pass of its own.
 */
export async function forgetGroupsAbsentFromServer(
  mlsService: IMlsService,
  snapshot: GroupSweepSnapshot,
  log: (msg: string) => void,
  verdicts?: AbsentGroupVerdicts
): Promise<boolean> {
  if (!snapshot.absenceIsEvidence) {
    if (snapshot.localGroups.size > 0) {
      log(`[SYNC] WASM purge skipped - ${snapshot.unusableReason}`);
    }
    return false;
  }

  let mutated = false;
  let keptOnThisPass = 0;
  for (const groupId of snapshot.localGroups) {
    if (snapshot.serverGroupIds.has(groupId)) continue;
    // ONLY A `keep` THE SERVER ACTUALLY GAVE IS REUSED, and only those are recorded. A `forget` was
    // acted on by the sweep that heard it, so the group is no longer local; were it still here, that
    // would be a forget that did not happen, and the question deserves asking again. A `keep` taken
    // because the row could not be read is the absence of an answer, not an answer: believing it for
    // the rest of the pass would spare, on a transport failure, an orphan the next sweep's read
    // would have collected.
    if (verdicts?.get(groupId)?.action === 'keep') {
      keptOnThisPass++;
      continue;
    }
    const fate = await reconcileAbsentLocalGroup(mlsService, groupId);
    if (fate.action === 'keep' && fate.serverAnswered) verdicts?.set(groupId, fate);
    if (fate.action === 'keep') {
      log(`[SYNC] WASM kept ${groupId.slice(0, 8)}… - ${fate.reason}`);
      continue;
    }
    // Through the shared helper, so both sweeps drop the same two halves. Forgetting the tree alone
    // would leave `isDistributionGroup` answering true for a group that is gone, and this very loop
    // spares whatever that predicate names.
    if (!(await forgetMlsGroupIfPresent(mlsService, groupId))) continue;
    log(`[SYNC] WASM removed (${fate.reason}): ${groupId.slice(0, 8)}…`);
    mutated = true;
  }
  // One line for the whole reuse: each group's own line was printed by the sweep that asked.
  if (keptOnThisPass > 0) {
    log(
      `[SYNC] ${keptOnThisPass} group(s) kept on the answer this connection pass already had - not asked again`
    );
  }
  return mutated;
}
