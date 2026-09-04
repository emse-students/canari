/**
 * THE PUBLISHED EXTERNAL-JOIN BASE, AND WHO REPAIRS IT WHEN IT FALLS BEHIND.
 *
 * WHAT IS BROKEN, IN THE CODE'S OWN WORDS. `runCommitTransaction` ends with
 * `void this.refreshGroupInfo(groupId)` under a comment that reads *"FIRE-AND-FORGET, AND WHAT IT
 * COSTS IS NOT NOTHING. This is the ONLY thing that mints a base, so losing it strands the group's
 * published base one epoch behind - permanently"*. The defect was documented and accepted, and the
 * repair it pointed at (`republishStaleBase`) runs for DISTRIBUTION groups only.
 *
 * **THE MEASUREMENT SAYS THE COMMENT IS RIGHT.** Production, 2026-09-04: four of the forty-three
 * groups holding a base were stale, and every single one by **exactly one epoch** - which is the
 * signature of one lost follow-up, not of drift. Two had been stale since 2026-08-30, with three
 * devices sitting `pending` on them, unable to join for five days. Three of the four are
 * conversations, so the existing repair could never have reached them.
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
  await mlsService.refreshGroupInfo(row.groupId);
  return verdict;
}
