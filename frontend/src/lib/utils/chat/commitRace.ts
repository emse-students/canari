import type { IMlsService } from '$lib/mls-client/IMlsService';
import { CommitRefusedError, rebuildableRefusal } from '$lib/mls-client/CommitRefusedError';
import { treeHoldsDevice } from '$lib/mls-client/leafIdentity';
import type { SkippedDevice } from '$lib/mls-client/skippedKeyPackage';

/**
 * Runs `attempt` - one commit of a member's gesture, built on the tree it reads itself - and runs it
 * AGAIN for as long as the gate refuses it for a reason {@link rebuildableRefusal} proves progress
 * on: the refusal's catch-up moved the local epoch (a foreign commit was consumed), or an overtaken
 * seat claim (an eviction landed). TERMINATION IS THAT PROOF, NEVER A COUNT OR A CLOCK: each pass
 * consumes one real commit of somebody else's. Every other failure leaves as thrown, so the caller
 * classifies it by type - a race refusal that moved nothing is `isCommitRaceRefusal`.
 *
 * THE ONE LOOP EVERY GESTURE SHARES (Add, Remove, the pending-invitation sweep): a lost race used to
 * end three different ways depending on who lost it (CC-1, CC-2, CC-4 of the 1.4.1 campaign).
 *
 * @param what - names the gesture in the log line.
 */
export async function rebuildOnRace<T>(
  mlsService: Pick<IMlsService, 'getEpoch'>,
  groupId: string,
  what: string,
  attempt: () => Promise<T>,
  log: (msg: string) => void = (msg) => console.log(msg)
): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (e) {
      // Only a refusal of the gate can prove progress; anything else leaves as thrown.
      if (!(e instanceof CommitRefusedError)) throw e;
      const caughtUpTo = mlsService.getEpoch(groupId);
      const why = rebuildableRefusal(e, caughtUpTo);
      if (why === null) throw e;
      log(
        `[COMMIT_RACE] ${groupId.slice(0, 8)}... ${what} was refused (${why}, now epoch ${caughtUpTo}) - rebuilding on the tree that won`
      );
    }
  }
}

/** One device a bulk Add offers, as `addMembersBulk` takes it. */
export interface AddCandidate {
  keyPackage: Uint8Array;
  deviceId: string;
  userId: string;
}

/** What {@link addDevicesRebuildingOnRace} did. */
export type RacedAddResult =
  /** The Add commit MERGED: every field is `addMembersBulk`'s, for the devices the tree lacked. */
  | {
      kind: 'added';
      welcome?: Uint8Array;
      ratchetTree?: Uint8Array;
      addedDeviceIds: string[];
      skipped: SkippedDevice[];
    }
  /** Every candidate already holds a leaf - by the commit that won a race, or before: no commit. */
  | { kind: 'already-in-tree' };

/**
 * The bulk Add every member gesture makes (an invitation, a 1:1 creation, a group's own devices),
 * rebuilt on a lost race by {@link rebuildOnRace}. Each pass reads the tree FIRST and offers only the
 * candidates without a leaf, so a winner that admitted one of them (its own external join, another
 * member's Add) is never added twice. Every candidate is excluded from the commit's fan-out - an
 * added device gets the Welcome, a skipped one is not in the group - exactly as each caller did.
 *
 * @throws what the last attempt threw when it proves no progress - a race refusal that moved
 *   nothing included (`isCommitRaceRefusal`), which the caller surfaces.
 */
export async function addDevicesRebuildingOnRace(
  mlsService: IMlsService,
  groupId: string,
  candidates: AddCandidate[],
  log: (msg: string) => void
): Promise<RacedAddResult> {
  return rebuildOnRace(
    mlsService,
    groupId,
    `the Add of ${candidates.length} device(s)`,
    async () => {
      const leaves = await mlsService.getGroupMemberIdentities(groupId);
      const missing = candidates.filter((d) => !treeHoldsDevice(leaves, d.userId, d.deviceId));
      if (missing.length === 0) {
        log(
          `[COMMIT_RACE] ${groupId.slice(0, 8)}... all ${candidates.length} device(s) already hold a leaf - no Add`
        );
        return { kind: 'already-in-tree' } as const;
      }
      const bulk = await mlsService.addMembersBulk(
        groupId,
        missing,
        missing.map((d) => `${d.userId}:${d.deviceId}`)
      );
      return { kind: 'added', ...bulk } as const;
    },
    log
  );
}
