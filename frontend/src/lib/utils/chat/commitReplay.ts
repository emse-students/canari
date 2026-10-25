import { fromBase64 } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { noteFrameConsumed } from '$lib/utils/chat/history';
import { clearEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { refusedBacklogIsQueued } from '$lib/mls-client/messagePipeline/unackedFrames';

/** Outcome of a rung-1 commit replay attempt. */
export interface CommitReplayResult {
  /** True when the local epoch reached the server `activeEpoch` (gap fully healed, no state loss). */
  healed: boolean;
  /** True when the commits needed were pruned from the server log - the caller must fall to rung 2. */
  belowFloor: boolean;
  /**
   * The epoch the server's commit log cannot supply, when it named one. Like `belowFloor` this is a
   * TERMINATING answer - rung 1 can never finish - but it says the log is holed in the MIDDLE rather
   * than short at the start, which is the difference between "too old" and "never written".
   */
  gapAt?: number;
  /** Number of commits actually applied. */
  applied: number;
  /**
   * The server's epoch the replay aimed at, when the log answered. A caller that must know when a gap
   * is CLOSED - not merely narrowed by one commit - compares the local epoch against this.
   */
  activeEpoch?: number;
}

/**
 * Rung-1 gap recovery (non-destructive): fetch the ordered commits this device missed and re-apply
 * them so the local epoch catches up to the server, INSTEAD of dropping local state and re-Welcoming
 * (rung 2). Commits are applied in ascending `baseEpoch` order via {@link IMlsService.processIncomingMessage}
 * (the same path a live member uses), skipping any already applied. Replay stops at the first commit
 * that fails to apply (e.g. this device's own commit after a crash-before-merge, which OpenMLS will
 * not re-process) and reports `healed=false` so the caller can fall back to rung 2.
 *
 * The server commit-log stores only ciphertext, so replaying it is a pure crypto catch-up with no
 * privacy change - the client still cryptographically verifies each commit as it applies it.
 *
 * `userId` IS HERE FOR THE LEDGER, AND THAT IS THE WHOLE OF WHY IT IS A PARAMETER. Every commit
 * applied below spends a generation the shared archive also holds, and until 2026-09-07 nothing
 * recorded it - so the archive replay walked the same row later, MLS refused it as a spent
 * generation, and the client reported a real message permanently lost and asked a peer to reconcile.
 * See {@link noteFrameConsumed}.
 */
export async function attemptCommitReplay(
  mlsService: IMlsService,
  groupId: string,
  userId: string,
  log: (msg: string) => void,
  /**
   * Stop once the group reaches this epoch, instead of the server's.
   *
   * FOR A CALLER WHOSE QUEUE STILL HOLDS FRAMES SEALED AT THE EPOCHS IN BETWEEN. Replaying straight to
   * the server's epoch jumps past them, and `max_past_epochs` is 2: every seed sealed more than two
   * epochs back becomes unreadable for good. Measured on production 2026-09-28: a key group at epoch 4
   * with its queue holding the commits and seeds of epochs 5 to 15 - only the commit 4->5 was missing.
   * Replaying that ONE commit lets the queue do the rest, in order, and loses nothing.
   */
  untilEpoch?: number
): Promise<CommitReplayResult> {
  const startEpoch = mlsService.getEpoch(groupId);
  const { commits, activeEpoch, belowFloor, gapAt } = await mlsService.fetchCommitsSince(
    groupId,
    startEpoch
  );

  if (belowFloor) {
    log(`[GAP] ${groupId.slice(0, 8)}… below commit-log floor - rung-2 re-Welcome needed`);
    return { healed: false, belowFloor: true, applied: 0, activeEpoch };
  }

  // A HOLE IN THE LOG IS A TERMINATING ANSWER, NOT A SHORTER REPLAY. The server names the first
  // epoch it cannot supply, and nothing it CAN supply reaches `activeEpoch` past that point - so
  // applying the prefix is work whose only sequel is the rung-2 that was owed either way.
  //
  // Before the server reported the hole this branch did not exist: the prefix was applied, the next
  // commit threw, the loop below broke on it, and the group sat frozen with `healed=false` until
  // the sync watchdog's `STUCK_EPOCH_GAP_MS` expired. That is a timer standing in for a fact the
  // server held all along (measured on prod 2026-09-02, group `7da231f8`, epoch 121 absent).
  if (gapAt !== undefined) {
    log(
      `[GAP] ${groupId.slice(0, 8)}… commit log is holed at epoch ${gapAt} - rung-2 re-Welcome needed`
    );
    return { healed: false, belowFloor: false, gapAt, applied: 0, activeEpoch };
  }

  let applied = 0;
  // THIS DEVICE'S OWN UNRESOLVED COMMIT IS SETTLED BY THE LOG, NEVER PROCESSED FROM IT: openmls
  // refuses a commit of its own, so the replay used to stop on it - at the very row proving it was
  // accepted. The row at our base epoch is decided for good (unique per epoch, written with the
  // advance), so it merges ours or clears ours for another's; no row decides nothing.
  const atStart = commits.find((c) => c.baseEpoch === startEpoch);
  const settled = await mlsService.settleUnresolvedCommitFromLog(groupId, atStart?.proto ?? null);
  if (settled === 'merged') applied++;
  const target = untilEpoch === undefined ? activeEpoch : Math.min(untilEpoch, activeEpoch);
  for (const c of commits) {
    if (mlsService.getEpoch(groupId) >= target) break;
    // Skip commits already applied (baseEpoch behind our current epoch).
    if (c.baseEpoch < mlsService.getEpoch(groupId)) continue;
    try {
      const bytes = fromBase64(c.proto);
      await mlsService.processIncomingMessage(groupId, bytes);
      // AFTER the await, so only a commit that really applied is claimed: a throw consumes nothing,
      // and claiming it would tell every later reader "already read" about a frame nobody has read.
      noteFrameConsumed(userId, groupId, bytes);
      applied++;
    } catch (e) {
      log(`[GAP] replay stopped at epoch ${c.baseEpoch}: ${String(e).slice(0, 80)}`);
      break;
    }
  }

  // "Nothing to replay" is NOT "the gap is closed". Being already at the server's active epoch when
  // a frame failed to decrypt means the failure was never an epoch gap, so this replay cannot have
  // repaired anything - reporting `healed` there is a verdict about EPOCHS answering a question
  // about something else, and it cost WP-PENDING-2 a silently dropped message: 0 commits applied,
  // epoch 1 -> 1, `healed=true`, and the frame ACKed off the server.
  const reachedTarget = mlsService.getEpoch(groupId) >= target;
  const healed = reachedTarget && (applied > 0 || startEpoch < target);
  log(
    `[GAP] ${groupId.slice(0, 8)}… replayed ${applied} commit(s), epoch ${startEpoch}->${mlsService.getEpoch(groupId)} (target ${target}${target < activeEpoch ? `, server at ${activeEpoch}` : ''}), healed=${healed}${
      reachedTarget && !healed ? ' (nothing to replay - the gap is not an epoch gap)' : ''
    }`
  );
  return { healed, belowFloor: false, applied, activeEpoch };
}

/** What {@link replayAndRecord} did: a replay's result, or a replay it declined to run. */
export type RecordedReplay = CommitReplayResult & {
  /**
   * True when no commit was replayed because frames of this group refused for lack of a
   * conversation row are still queued ({@link refusedBacklogIsQueued}): the epochs are on their way
   * in order, and a replay past them would make their application frames unreadable for good.
   */
  heldBehindRefusedBacklog?: true;
};

/**
 * Rung 1 AND ITS BOOKKEEPING, the one way every caller outside the key-group catch-up replays: the
 * message pipeline's gap healer, a refused commit's catch-up, and a gesture confirming its tree
 * (`readConfirmedTree`). Each used to do its own share of the three duties below, and the third
 * caller did none of them:
 *
 * - **Persist** when the epoch moved - a partial replay is as durable-worthy as a healed one, so
 *   `persist` runs on `healed` OR any applied commit;
 * - **Un-mark the gap on a heal** - a group left in the epoch-gap registry keeps its outbox frozen
 *   and the sync watchdog heading for rung 2 on a group that has none;
 * - **Hold behind a refused backlog** (`refusedBacklog: 'hold'`): when this group's earlier frames
 *   were refused for lack of a row they are still queued, commits AND the application frames
 *   between them, and replaying the commits alone jumps past those frames (`max_past_epochs` is 2):
 *   47 of 150 lost on a Pixel 6a, prod 1.2.7, 2026-10-14. A hold ASKS FOR THE PULL that brings them
 *   (`notifyConversationAvailable`) and prints nothing: the caller's one line says it. The pipeline passes `'judged-by-caller'`:
 *   its own guard is narrower on purpose (a frame the backlog pull hands over must still reach the
 *   ladder, or nothing would ever discharge it).
 *
 * Takes no lock: callers hold the MLS lock, as rung 1 always has.
 *
 * @param persist - the caller's persistence: the pipeline's immediate one, or the scheduled one.
 */
export async function replayAndRecord(
  mlsService: IMlsService,
  groupId: string,
  userId: string,
  log: (msg: string) => void,
  opts: { persist: () => void; refusedBacklog: 'hold' | 'judged-by-caller' }
): Promise<RecordedReplay> {
  if (opts.refusedBacklog === 'hold' && refusedBacklogIsQueued(groupId)) {
    // HELD, AND THE PULL THAT ENDS THE HOLD IS ASKED HERE - as the pipeline's own hold asks it. The
    // mark is discharged only by a pull, and nothing else may start one: a quiet conversation has no
    // next frame, so the hold would last until the stuck-gap escalation (rung 2) or a reconnect. The
    // caller says it in ONE line of its own; this prints none, so a hold is never told twice.
    mlsService.notifyConversationAvailable(groupId);
    return { healed: false, belowFloor: false, applied: 0, heldBehindRefusedBacklog: true };
  }
  const replay = await attemptCommitReplay(mlsService, groupId, userId, log);
  if (replay.healed || replay.applied > 0) opts.persist();
  if (replay.healed) clearEpochGap(groupId);
  return replay;
}
