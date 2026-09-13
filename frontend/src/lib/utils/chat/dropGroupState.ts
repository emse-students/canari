/**
 * The one way this device stops holding the MLS state for a group - the only thing that makes
 * {@link holdsGroupState} answer false.
 *
 * ## Why it is one function
 *
 * `forgetGroup` was called at seventeen sites, and what each one did AROUND it was written out by
 * hand. Two things belong to the drop itself and neither survived being copied:
 *
 * - **The durable checkpoint.** `forgetGroup` mutates the OpenMLS store, and the encrypted snapshot
 *   is written separately - so a drop with no checkpoint is undone by the next load. Seven of the
 *   seventeen wrote none, `recoverForkedGroup` among them: it forgot a forked tree, asked to be
 *   re-added, and a page killed before the next unrelated checkpoint restored the fork.
 * - **The epoch gap.** {@link isInEpochGap} is a claim about HELD state lagging behind the group's
 *   epoch, and a device holding nothing has no epoch to be behind. Two of the seventeen cleared it.
 *   The entry left behind outlives the state it describes twice over: `canSendInGroup` refuses to
 *   encrypt in the group this device has just re-joined cleanly, and `anyEpochGapArmed` stays true,
 *   which is what keeps the sync watchdog on its fine tick for the rest of the session.
 *
 * ## The one thing that legitimately differs, and it travels as a flag
 *
 * `checkpoint` states a FACT about the state being dropped, not a preference:
 *
 * - `'awaited'` - it is in the durable snapshot, and the caller waits for the snapshot without it.
 * - `'deferred'` - the same, from a holder of the MLS client mutex, where awaiting a whole
 *   encrypted save (1.7 s on a phone, measured) would put it in front of every other MLS
 *   operation. The write is the same call, started here and left to the session persister.
 * - `'never-persisted'` - the state was built in memory during this very operation and no
 *   checkpoint has run since, so there is nothing durable to undo. `externalJoin` discarding a
 *   refused commit is the case: writing the snapshot would cost a save per failed attempt and the
 *   next load already knows nothing of the group.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import { clearEpochGap } from './epochGapRegistry';

/** What a caller of {@link dropGroupState} must be able to do. */
export type DroppableMlsService = Pick<IMlsService, 'forgetGroup' | 'persistCheckpoint'>;

/** Options for {@link dropGroupState}. */
export interface DropGroupStateOptions {
  /**
   * Why the state is being dropped, for the one log line. Required: a drop is a structural event
   * that costs this device its ability to read the group until it re-joins, and a line saying only
   * that it happened sends the next reader back to the source to find out which of seventeen paths
   * it was.
   */
  reason: string;
  /**
   * Floor for a later re-Welcome, passed straight to `forgetGroup`. `0` accepts any, which is right
   * when there is no diverged branch to protect against; a fork recovery passes the server's epoch
   * so a Welcome queued on the branch just abandoned cannot re-install it.
   */
  minEpoch?: number;
  /** How this drop becomes durable - see this module's doc. All three make a claim, not a choice. */
  checkpoint: 'awaited' | 'deferred' | 'never-persisted';
  /** Session log sink; `console.log` when the caller has none. */
  log?: (msg: string) => void;
}

/**
 * Drops this device's local MLS state for `groupId`, clears what described it, and checkpoints.
 *
 * Never throws: a drop is always part of a larger repair, and a caller that cannot forget the
 * state is in no position to do anything about it. The failure is logged where it happens.
 */
export async function dropGroupState(
  mlsService: DroppableMlsService,
  groupId: string,
  { reason, minEpoch = 0, checkpoint, log }: DropGroupStateOptions
): Promise<void> {
  const write = log ?? ((msg: string) => console.log(msg));
  const short = groupId.slice(0, 8);

  try {
    mlsService.forgetGroup(groupId, minEpoch);
    write(`[MLS] dropped local state for ${short}... (${reason}, minEpoch=${minEpoch})`);
  } catch (e) {
    write(
      `[MLS] dropping local state for ${short}... (${reason}) FAILED: ` +
        (e instanceof Error ? e.message : String(e))
    );
  }

  // The gap describes state this device no longer holds. Cleared even when the forget threw: on
  // both platforms `forgetGroup` swallows its own failures, so a throw here means the state was
  // never reachable to begin with.
  clearEpochGap(groupId);

  if (checkpoint === 'never-persisted') return;

  // ONE CALL, AND THE FLAG DECIDES ONLY WHETHER IT IS AWAITED. Started before the branch so a
  // `'deferred'` drop cannot become a drop with no checkpoint at all.
  const durable = persistMlsStructuralCheckpoint({ mlsService }).catch((e: unknown) => {
    write(
      `[MLS] checkpoint after dropping ${short}... FAILED: ` +
        (e instanceof Error ? e.message : String(e))
    );
    return false;
  });
  if (checkpoint === 'awaited') await durable;
}
