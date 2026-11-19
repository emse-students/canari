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
 * WHETHER A LIVE OF `elapsedMs` LEAVES A REPLAY when it ends: the live's OWN `keepsReplay`, which the
 * server fixed at its start from `live_replays_mode` and answered with the live (`POST /api/lives`),
 * AND the live ran at least {@link LIVE_REPLAY_MIN_MS} (owner, 2026-11-09: a false start shows
 * nothing; the server's publication applies the same 30 s). Never the switch as read NOW: a switch
 * flipped during the live changes nothing for it, so the broadcaster's end texts must not follow it.
 */
export function replayFollows(keepsReplay: boolean, elapsedMs: number): boolean {
  return keepsReplay && elapsedMs >= LIVE_REPLAY_MIN_MS;
}
