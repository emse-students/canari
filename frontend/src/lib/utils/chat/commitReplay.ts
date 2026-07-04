import { fromBase64 } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mls-client/IMlsService';

/** Outcome of a rung-1 commit replay attempt. */
export interface CommitReplayResult {
  /** True when the local epoch reached the server `activeEpoch` (gap fully healed, no state loss). */
  healed: boolean;
  /** True when the commits needed were pruned from the server log - the caller must fall to rung 2. */
  belowFloor: boolean;
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
  const { commits, activeEpoch, belowFloor } = await mlsService.fetchCommitsSince(
    groupId,
    startEpoch
  );

  if (belowFloor) {
    log(`[GAP] ${groupId.slice(0, 8)}… below commit-log floor - rung-2 re-Welcome needed`);
    return { healed: false, belowFloor: true, applied: 0 };
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

  const healed = mlsService.getEpoch(groupId) >= activeEpoch;
  log(
    `[GAP] ${groupId.slice(0, 8)}… replayed ${applied} commit(s), epoch ${startEpoch}->${mlsService.getEpoch(groupId)} (target ${activeEpoch}), healed=${healed}`
  );
  return { healed, belowFloor: false, applied };
}
