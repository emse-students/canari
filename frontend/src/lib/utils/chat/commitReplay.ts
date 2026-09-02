import { fromBase64 } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mls-client/IMlsService';

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
 */
export async function attemptCommitReplay(
  mlsService: IMlsService,
  groupId: string,
  log: (msg: string) => void
): Promise<CommitReplayResult> {
  const startEpoch = mlsService.getEpoch(groupId);
  const { commits, activeEpoch, belowFloor, gapAt } = await mlsService.fetchCommitsSince(
    groupId,
    startEpoch
  );

  if (belowFloor) {
    log(`[GAP] ${groupId.slice(0, 8)}… below commit-log floor - rung-2 re-Welcome needed`);
    return { healed: false, belowFloor: true, applied: 0 };
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
    return { healed: false, belowFloor: false, gapAt, applied: 0 };
  }

  let applied = 0;
  for (const c of commits) {
    // Skip commits already applied (baseEpoch behind our current epoch).
    if (c.baseEpoch < mlsService.getEpoch(groupId)) continue;
    try {
      await mlsService.processIncomingMessage(groupId, fromBase64(c.proto));
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
  const reachedTarget = mlsService.getEpoch(groupId) >= activeEpoch;
  const healed = reachedTarget && (applied > 0 || startEpoch < activeEpoch);
  log(
    `[GAP] ${groupId.slice(0, 8)}… replayed ${applied} commit(s), epoch ${startEpoch}->${mlsService.getEpoch(groupId)} (target ${activeEpoch}), healed=${healed}${
      reachedTarget && !healed ? ' (nothing to replay - the gap is not an epoch gap)' : ''
    }`
  );
  return { healed, belowFloor: false, applied };
}
