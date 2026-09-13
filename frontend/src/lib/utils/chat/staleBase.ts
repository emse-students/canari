/**
 * THE PUBLISHED EXTERNAL-JOIN BASE, AND WHO REPAIRS IT WHEN IT FALLS BEHIND.
 *
 * WHAT IS BROKEN, AND FOR WHICH COMMITS. `runCommitTransaction` ends with
 * `void this.refreshGroupInfo(groupId)`, and for a STAGED add or remove that call is the only thing
 * that mints the successor base: the commit is unapplied at submit time, so the device cannot carry
 * the new epoch's base inside the submission the way an external join does. Lose it and the
 * published base stays one epoch behind for ever. (This paragraph used to quote that comment as
 * *"the ONLY thing that mints a base"* flatly; the comment itself was corrected in #571, and the
 * distinction it drew is the one that decides whether a group can fall behind at all.)
 *
 * **THE MEASUREMENT SAYS SO.** Production, 2026-09-04: four of the forty-three groups holding a base
 * were stale, and every single one by **exactly one epoch** - which is the signature of one lost
 * follow-up, not of drift. Two had been stale since 2026-08-30, with three devices sitting `pending`
 * on them, unable to join for five days. Three of the four are conversations, so the existing repair
 * could never have reached them.
 *
 * WHY THIS IS A REPAIR AND NOT A FALLBACK. The write that advances the epoch is durable and
 * transactional; the write that lets everyone ELSE reach that epoch is a best-effort follow-up. This
 * repository's rule for that shape is explicit: *the record that makes an authoritative write
 * survivable for everybody else may not be best-effort.* Making the publish part of the commit is
 * not the answer either - a commit that succeeded must not report failure because a follow-up did
 * not land. What makes it survivable is that **its loss is detectable and any holder can undo it**,
 * so the loss stops being permanent.
 *
 * THE FOUR PROPERTIES, AND EACH IS A HOUSE RULE RATHER THAN A PREFERENCE:
 *
 *  1. **The durable state is the SERVER'S, and there is no second copy.** `mls_group_info.baseEpoch`
 *     against `dm_groups.activeEpoch` IS the record of "a republish is owed" - authoritative, and
 *     answering exactly that question. A client-side owed-work queue (the `pendingGroupExits` shape)
 *     would be a duplicate of a fact somebody else may already have fixed, and durable state answers
 *     only the question it was written for.
 *  2. **The trigger is an event that already happens**, not a clock: `GET /mls/users/:id/groups` is
 *     the one call every device makes on every connection, and it now carries both epochs. Nothing
 *     polls, nothing is scheduled, and a device that never connects owes nothing.
 *  3. **Termination comes from a proof**: `baseEpoch === activeEpoch`. Not an attempt count, not a
 *     deadline. A republish that fails leaves the group exactly as stale as it was, and the next
 *     connection of any holder tries again.
 *  4. **Idempotence is free.** The server's publish is monotonic - a lower `baseEpoch` is ignored -
 *     so two holders repairing at once, or one repairing twice, cannot make the base worse.
 *
 * THE ONE THING A HOLDER MUST CHECK ABOUT ITSELF: its own tree may be behind too. A device at epoch
 * N cannot mint a base for a group at N+1, and publishing one would be replacing a stale base with
 * another stale base. That is a distinct verdict here, and it is logged, because a run in which every
 * holder is behind is a group nobody can repair and that is worth seeing.
 *
 * **AND THE CHECK IS A GUESS, WHERE THE SERVER HOLDS THE ANSWER.** `putGroupInfo` is strictly
 * monotonic and reports `stored: false` for a base that was not newer, which #571 threaded out of
 * the one publisher - so "did my base land" is answered authoritatively, for free, on every publish.
 * `classifyBase` is kept for what it is good at, deciding whether to spend a round trip at all on
 * every group of every connection, and {@link publishAndReport} is the ONE place that answer is
 * read. Two callers reach it: this module's steady-state repair, and
 * {@link answerBaseRefreshRequest} for a device locked out right now.
 */
import type { IMlsService } from '$lib/mls-client/IMlsService';

/** What a holder should do about a group's published base, and why. */
export type StaleBaseVerdict =
  /** No base has ever been published. A joiner asks for a Welcome; a holder has nothing to repair. */
  | { action: 'none'; why: 'no-base-published' }
  /** The base already describes the group's current epoch. */
  | { action: 'none'; why: 'current' }
  /** The server did not say, so nothing is KNOWN to be stale - never assume it is. */
  | { action: 'none'; why: 'server-did-not-say' }
  /** The base is behind AND this device's tree is behind too: it cannot mint a usable one. */
  | {
      action: 'none';
      why: 'this-device-is-behind-too';
      baseEpoch: number;
      activeEpoch: number;
      localEpoch: number;
    }
  /** The base is behind and this device holds the current tree: republish. */
  | { action: 'republish'; baseEpoch: number; activeEpoch: number };

/**
 * Decides, from three numbers, whether this device should republish a group's external-join base.
 *
 * Pure on purpose: the interesting mistakes here are all arithmetic and all silent. Reading a
 * missing `activeEpoch` as `0` calls every base stale; reading a missing `baseEpoch` as `0` calls an
 * unpublished group stale; forgetting the local epoch republishes a stale base over a stale base.
 * None of those fails loudly, and each is one line.
 */
export function classifyBase(input: {
  baseEpoch?: number | null;
  activeEpoch?: number;
  localEpoch: number;
}): StaleBaseVerdict {
  const { baseEpoch, activeEpoch, localEpoch } = input;
  // An older server sends neither, and the pair is what makes the question askable at all.
  if (typeof activeEpoch !== 'number') return { action: 'none', why: 'server-did-not-say' };
  if (baseEpoch === null || baseEpoch === undefined) {
    return { action: 'none', why: 'no-base-published' };
  }
  if (baseEpoch >= activeEpoch) return { action: 'none', why: 'current' };
  if (localEpoch < activeEpoch) {
    return { action: 'none', why: 'this-device-is-behind-too', baseEpoch, activeEpoch, localEpoch };
  }
  return { action: 'republish', baseEpoch, activeEpoch };
}

/**
 * Republishes `groupId`'s external-join base if it is behind and this device can mint a usable one.
 *
 * Called by the holder on its own ordinary read, and by the member a locked-out device explicitly
 * asks (`base_refresh_request`). The two are not duplicates: this one heals the steady state without
 * anybody asking, that one makes it immediate for a device that is refused RIGHT NOW.
 *
 * Never throws. `refreshGroupInfo` already swallows its own failure, and a repair that took the
 * connection down would be worse than the staleness it fixes; what it must never do is fail
 * silently, so every branch says what it decided.
 */
export async function republishBaseIfStale(
  mlsService: IMlsService,
  row: { groupId: string; baseEpoch?: number | null; activeEpoch?: number },
  log: (message: string) => void
): Promise<StaleBaseVerdict> {
  const verdict = classifyBase({
    baseEpoch: row.baseEpoch,
    activeEpoch: row.activeEpoch,
    localEpoch: mlsService.getEpoch(row.groupId),
  });
  const short = row.groupId.slice(0, 8);

  if (verdict.action === 'none') {
    // AT A LEVEL THAT ACCUSES for the one case that is a dead end: the base is behind and this
    // device cannot help. Its rate is what says whether a stale base is a moment or a state.
    if (verdict.why === 'this-device-is-behind-too') {
      log(
        `[BASE] ${short}... the published base is at epoch ${verdict.baseEpoch} while the group is at ` +
          `${verdict.activeEpoch}, and this device's tree is at ${verdict.localEpoch} - it cannot mint a ` +
          `usable base either, so no stateless device can enter until a current member connects`
      );
    }
    return verdict;
  }

  log(
    `[BASE] ${short}... the published base is at epoch ${verdict.baseEpoch} while the group is at ` +
      `${verdict.activeEpoch} - republishing from the tree this device holds`
  );
  await publishAndReport(mlsService, row.groupId, '[BASE]', log);
  return verdict;
}

/**
 * PUBLISHES THIS DEVICE'S BASE AND REPORTS WHAT THE SERVER DID WITH IT - the one reading of the one
 * publisher's answer.
 *
 * #571 made `publishCurrentBase` the single publisher and threaded its answer out of
 * `refreshGroupInfo`; what was left was two callers deciding separately what to do with it, and only
 * one of them doing anything. {@link republishBaseIfStale} discarded it entirely - a repair that
 * logged *republishing from the tree this device holds* and then never said whether the tree was
 * taken - while the `base_refresh_request` responder read it. **The asymmetry is the duplicate**:
 * one question, one answer already computed, and two places entitled to describe it.
 *
 * The three answers are three lines and the TAG is the context. `[BASE]` is a holder healing the
 * steady state on its own read; `[BASE_REFRESH]` is a holder answering a device that cannot get in
 * at all. Nothing else differs, so nothing else is written twice - a second wording for one answer
 * is how two callers come to disagree about what happened.
 */
async function publishAndReport(
  mlsService: IMlsService,
  groupId: string,
  tag: '[BASE]' | '[BASE_REFRESH]',
  log: (message: string) => void
): Promise<{ stored: boolean; baseEpoch: number } | null> {
  const short = groupId.slice(0, 8);
  const published = await mlsService.refreshGroupInfo(groupId);
  if (published === null) {
    // A publish that never landed proves NOTHING about the base - it is neither of the two below,
    // and reading it as the refusal is what turns a dropped packet into "nobody can repair this".
    log(`${tag} ${short}... the republish did not land - the base is exactly as stale as it was`);
  } else if (published.stored) {
    // THE EPOCH IT PUBLISHED, NOT THE ONE IT IS AT NOW - a later `getEpoch` answers a different
    // question, and reporting it here names a base that was never stored.
    log(
      `${tag} ${short}... the server took it - the base now describes epoch ${published.baseEpoch}`
    );
  } else {
    log(
      `${tag} ${short}... the server KEPT the base it had - this device offered epoch ` +
        `${published.baseEpoch}, which is not newer: either another holder repaired it first, or ` +
        `no holder that has connected can`
    );
  }
  return published;
}

/** What answering a `base_refresh_request` came to. `null` is a publish that never landed. */
export type BaseRefreshAnswer =
  | { stored: boolean; baseEpoch: number }
  | null
  /** Nothing was offered: this device holds no active MLS state for the group. */
  | 'no-local-state';

/**
 * Answers a `base_refresh_request` - a device that cannot external-join `groupId` at all has asked
 * this member to republish its base.
 *
 * **THE SIBLING OF {@link republishBaseIfStale}, AND NOT A VARIANT OF IT.** That one heals the
 * steady state on a holder's ordinary read, without anybody asking; this one makes the repair
 * immediate for a device refused RIGHT NOW. They cannot be one function: this is handed a group id
 * and nothing else, where {@link classifyBase} needs the group's `activeEpoch` to decide whether a
 * publish is worth a round trip. What they share is {@link publishAndReport}.
 *
 * A DEVICE ASKING FOR A BASE REFRESH CANNOT GET IN AT ALL, so this is answered before anything else
 * and logged at a level that accuses. The published base names an epoch the group has left; nothing
 * but a member's publish can move it, and only a staged commit's follow-up otherwise does - so on a
 * quiet conversation a stale base is permanent. Measured on production 2026-09-04: four groups
 * stale, all by exactly one epoch, two of them since 2026-08-30 with three devices sitting
 * `pending` on them.
 *
 * WHAT THIS IS NOT: it is not an Add. Nothing here mutates the tree, takes the group's add lock or
 * changes an epoch - the publish exports what this device already holds. That is the whole reason
 * the requester asks for THIS rather than for a Welcome.
 *
 * A RESPONDER WHOSE OWN TREE IS BEHIND CANNOT HELP, AND DOES NOT HAVE TO CHECK BEFOREHAND, BECAUSE
 * THE SERVER TELLS IT AFTERWARDS. The publish is monotonic - a base whose epoch is not above the
 * stored one is ignored - so a behind device cannot make the base worse, and the requester's next
 * ask is forwarded to a randomly re-elected member.
 *
 * **IT LIVES HERE AND NOT IN `sessionAuth` BECAUSE A RESPONDER NOTHING CAN CALL IS A RESPONDER
 * NOTHING CAN DRIVE.** It was the half of this pair with no coverage of any kind. Never throws: it
 * is invoked from a WebSocket message handler, where a rejection belongs to no group at all.
 */
export async function answerBaseRefreshRequest(
  mlsService: IMlsService,
  groupId: string,
  log: (message: string) => void
): Promise<BaseRefreshAnswer> {
  const short = groupId.slice(0, 8);
  try {
    if (!(await mlsService.isGroupActive(groupId))) {
      // Not a fault of the requester's, and not silent: this device was elected and holds no usable
      // state for the group, so the ask has to reach somebody else.
      log(
        `[BASE_REFRESH] ${short}... this device holds no active MLS state for it - cannot mint a base`
      );
      return 'no-local-state';
    }
    return await publishAndReport(mlsService, groupId, '[BASE_REFRESH]', log);
  } catch (e) {
    log(`[BASE_REFRESH] ${short}... refresh failed: ${String(e).slice(0, 120)}`);
    return null;
  }
}
