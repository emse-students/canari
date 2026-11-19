import { LIVE_ENABLED } from '$lib/features';
import type { LiveReplaysMode } from '$lib/utils/appVersion';

/**
 * WHETHER A LIVE REPLAY IS ASKED FOR AND DRAWN (owner, 2026-11-09: nothing when the switch is off):
 * the build's lives switch AND the server's `live_replays_mode`, as `livesAvailability.ts` joins the
 * two locks of lives. The server enforces its own side - it serves no replay to a client that did not
 * ask (`withReplays`) - so this is the CLIENT's half: with the mode off, `listPosts` and `getPost`
 * never ask, and a replay row left in a cache is not drawn.
 *
 * Pure, and given the mode rather than reading it, so a component passes `serverLiveReplaysMode()`
 * inside its own reactive expression and the surface hides on the refresh that closes replays.
 */
export function replaysAvailable(mode: LiveReplaysMode): boolean {
  return LIVE_ENABLED && mode === 'on';
}

/** What the broadcaster's end screen says of the replay: one value, the server's. */
export type ReplayEndText = 'kept' | 'none' | 'pending';

/**
 * THE BROADCASTER'S END TEXT, from SERVER facts only - never a client clock, which runs from another
 * origin than the database's and would disagree near 30 s (owner, 2026-11-09: a live under
 * `LIVE_REPLAY_MIN_MS` keeps none). `keepsReplay` is the live's own, fixed by the server at its
 * start (a switch flipped during the live changes nothing for it); `verdict` is the end's answer,
 * decided once on the database clock from what the server received. A live that keeps none is
 * `none` at once; otherwise the screen waits for the verdict (`pending`) and then says it.
 */
export function replayEndText(keepsReplay: boolean, verdict: boolean | null): ReplayEndText {
  if (!keepsReplay || verdict === false) return 'none';
  return verdict === true ? 'kept' : 'pending';
}
