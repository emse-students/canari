import type { IMlsService } from '$lib/mls-client/IMlsService';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import { replayAndRecord } from './commitReplay';

/**
 * A reading of a group's tree that a commit may be decided on:
 * - `read`: the leaf identities, either decided by the local tree alone (the caller's
 *   `decidedLocally` said so) or read at the server's epoch;
 * - `unconfirmed`: the tree is behind the server and could not be caught up, or the log or the tree
 *   could not be read - it proves nothing.
 */
export type TreeReading = { status: 'read'; identities: string[] } | { status: 'unconfirmed' };

/**
 * Reads `groupId`'s leaf identities from a tree CONFIRMED CURRENT whenever the local answer is not
 * enough on its own.
 *
 * WHY A LOCAL TREE IS NOT ALWAYS AN ANSWER: a tree behind a commit it has not applied answers for an
 * epoch the server has left - "out" of a member an Add re-admitted, "in" of a device a Remove took
 * out. A gesture deciding what to commit on it (skip a Remove, skip a device of an Add) decides on
 * the past. So when `decidedLocally` says the local reading is not decisive, the server's commit log
 * is asked: at its epoch the reading stands, ahead of it the rung-1 replay applies what is missing
 * WITH ITS BOOKKEEPING ({@link replayAndRecord}: persisted, the gap registry un-marked on a heal,
 * held behind a refused backlog), and a tree still behind - a log that cannot be read, a replay
 * held - is `unconfirmed`, never an answer.
 *
 * `decidedLocally` exists because one direction needs no confirmation: what a commit is about to
 * change is checked by the epoch gate anyway (a stale base is refused), so only the reading that
 * would SKIP the commit has to be current.
 *
 * **THE WHOLE CONFIRMATION RUNS UNDER THE MLS LOCK**, like the pipeline's rung 1: the replay applies
 * commits and may settle a staged one ({@link IMlsService.settleUnresolvedCommitFromLog} merges or
 * clears), and only sends may mutate the client outside the mutex. Nothing here takes the lock
 * itself, so the caller MUST NOT HOLD IT: the lock is not re-entrant, and a call from inside it
 * waits for itself for ever (pinned by `confirmedTree.test.ts` on the real scheduler).
 *
 * @param logTag - the caller's log prefix, e.g. `[REMOVE_MEMBER]`.
 */
export async function readConfirmedTree(
  mlsService: IMlsService,
  groupId: string,
  actingUserId: string,
  logTag: string,
  decidedLocally: (identities: readonly string[]) => boolean
): Promise<TreeReading> {
  const short = groupId.slice(0, 8);
  try {
    return await mlsService.runUnderMlsLock(async (): Promise<TreeReading> => {
      const local = await mlsService.getGroupMemberIdentities(groupId);
      if (decidedLocally(local)) return { status: 'read', identities: local };
      const epoch = mlsService.getEpoch(groupId);
      const { activeEpoch } = await mlsService.fetchCommitsSince(groupId, epoch);
      if (activeEpoch <= epoch) return { status: 'read', identities: local };
      console.log(
        `${logTag} ${short}… the tree is behind the server (epoch ${epoch} < ${activeEpoch}) - catching up before it is read`
      );
      const replay = await replayAndRecord(
        mlsService,
        groupId,
        actingUserId,
        (msg) => console.log(msg),
        { persist: scheduleOutboundMlsPersist, refusedBacklog: 'hold' }
      );
      if (replay.heldBehindRefusedBacklog) {
        console.log(
          `${logTag} ${short}… not caught up: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked, the tree is unconfirmed`
        );
        return { status: 'unconfirmed' };
      }
      const now = mlsService.getEpoch(groupId);
      if (now < activeEpoch) {
        console.warn(
          `${logTag} ${short}… the tree is still behind the server (epoch ${now} < ${activeEpoch}) - its answer is not trusted`
        );
        return { status: 'unconfirmed' };
      }
      return { status: 'read', identities: await mlsService.getGroupMemberIdentities(groupId) };
    });
  } catch (e) {
    console.warn(`${logTag} ${short}… the tree could not be confirmed: ${String(e).slice(0, 120)}`);
    return { status: 'unconfirmed' };
  }
}
