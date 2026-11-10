import { LIVE_ENABLED } from '$lib/features';
import { LIVE_REPLAY_MIN_MS } from './constants';
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

/**
 * WHETHER A LIVE OF `elapsedMs` LEAVES A REPLAY when it ends: replays are available AND the live ran
 * at least {@link LIVE_REPLAY_MIN_MS} (owner, 2026-11-09: a false start shows nothing). The broadcaster's
 * texts promise "visible 3 jours" only when this holds. The server decides - this only keeps the
 * screen from promising what a 10-second live will not get.
 */
export function replayFollows(mode: LiveReplaysMode, elapsedMs: number): boolean {
  return replaysAvailable(mode) && elapsedMs >= LIVE_REPLAY_MIN_MS;
}
