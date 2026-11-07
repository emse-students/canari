import type { CheckpointSkipMode } from '$lib/utils/appVersion';

/**
 * How many application FRAMES (ratchet generations) a run of live receive-only drains may leave
 * unsaved before a drain checkpoints anyway, while the switch is `on`.
 *
 * THE MEASURED VALUE, AND A COUNT, NEVER A CLOCK. The Mi 9T crash measurement of 2026-10-22 ran
 * K = 20 and K = 100 (6 valid trials, up to 60 skipped frames: 0 lost, 0 `live-ahead`, 0 duplicates,
 * 0 unreadable). The bound it must stay under is the sender ratchet window
 * (`maximum_forward_distance` = 2000, mls-core `group.rs`): the worst case is K - 1 skipped frames
 * plus the drain that reaches K, which checkpoints but loses its own frames to a kill DURING it - so
 * a drain of up to ~1900 frames is still recovered by moving the ratchet forward
 * (docs/wiki/open-questions.md, the checkpoint-skip section).
 */
export const RECEIVE_CHECKPOINT_SKIP_BUDGET = 100;

/**
 * The persister's `receiveSkipBudget` for a server mode: {@link RECEIVE_CHECKPOINT_SKIP_BUDGET} when
 * the estate's `checkpointSkip.mode` (`/api/version`, `platform_config.checkpoint_skip_mode`) is
 * `on`, and 0 - every drain checkpoints, the behaviour every build had before WP-CHECKPOINT-SKIP -
 * otherwise. The mode is the lead's switch, OFF in every estate until the readings of
 * docs/wiki/device-verification.md pass; the budget is not a server value, so no admin can set a
 * number the ratchet window does not allow.
 */
export function receiveCheckpointSkipBudget(mode: CheckpointSkipMode): number {
  return mode === 'on' ? RECEIVE_CHECKPOINT_SKIP_BUDGET : 0;
}
