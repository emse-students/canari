import { Log } from '$lib/utils/Log';

/**
 * OPENING A VIDEO FULL SCREEN PICKS UP WHERE IT IS (user, 2026-10-02: *"ouvrir une video en grand
 * devrait reprendre la ou elle en est, pas au debut"*).
 *
 * The inline video and the viewer's player are two `<video>` elements, so the viewer started at 0 -
 * a clip watched to 0:12 in the conversation began again from its first frame. Several places open
 * the viewer from an inline video (a chat bubble, a post, a post's gallery, a reel), so the position
 * does not travel as a prop through each of them: the inline `VideoPlayer` (`feed`, `chat`) writes it here at the moment of
 * opening, and the viewer's `VideoPlayer` reads it when it mounts. THE KEY IS THE MEDIA (owner,
 * 2026-11-10): a post's media id, which names the same video whether the two players hold the same
 * blob URL or two streams of it (the CanaReels viewer opens its own); else the URL. A position is
 * TAKEN, not read: once the viewer has it,
 * it is gone, so a later open of the same file from somewhere that never played it starts at 0.
 */
const positions = new Map<string, number>();

/** Notes how far `src` has played, as the reader opens it full screen. */
export function rememberVideoPosition(src: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    positions.delete(src);
    return;
  }
  Log.d('videoResume', `remembered ${seconds.toFixed(1)} s`);
  positions.set(src, seconds);
}

/** The position noted for `src`, which is forgotten by the asking - or 0 when there is none. */
export function takeVideoPosition(src: string): number {
  const seconds = positions.get(src) ?? 0;
  positions.delete(src);
  return seconds;
}

/**
 * LEAVING FULL SCREEN NEVER RESTARTS THE INLINE VIDEO (owner, 2026-11-10: "en quittant, la video du
 * fil reprend la ou le plein ecran l'a laissee"). The inline player that opened a viewer WAITS for
 * it ({@link awaitVideoHandBack}); the viewer's player, as it leaves, HANDS BACK where it got to
 * ({@link handBackVideoPosition}) under the same key, and the inline player seeks there. Event, not
 * clock: the hand-back is the viewer's teardown itself. A viewer of a video nobody opened from inline
 * (the reels' next pages) hands back into nothing, which is said at debug.
 *
 * The waiter stays until the inline player opens a viewer again or goes, or the viewer's owner ends it
 * once the viewer is gone ({@link endVideoHandBack}), so a viewer that hands back
 * twice (its slide swiped away and back, then closed) leaves the inline video at the LAST place.
 */
const waiters = new Map<string, (seconds: number) => void>();

/** Waits for the viewer opened on `key` to hand back its position; returns the cancel. */
export function awaitVideoHandBack(key: string, apply: (seconds: number) => void): () => void {
  waiters.set(key, apply);
  return () => {
    if (waiters.get(key) === apply) waiters.delete(key);
  };
}

/**
 * Ends the wait on `key` once the viewer it was for is gone (its players handed back as they were
 * destroyed): a later viewer of the same media opened from elsewhere must not move this card.
 */
export function endVideoHandBack(key: string): void {
  if (waiters.delete(key)) Log.d('videoResume', 'the viewer is gone - the hand-back wait ends');
}

/** A viewer's player leaves: where it got to goes back to the inline player that opened it, if any. */
export function handBackVideoPosition(key: string, seconds: number): void {
  const apply = waiters.get(key);
  if (!apply) {
    Log.d('videoResume', 'a viewer left - no inline player waits for it');
    return;
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.warn(`[videoResume] a viewer handed back an unusable position (${seconds}) - ignored`);
    return;
  }
  Log.d('videoResume', `handed back ${seconds.toFixed(1)} s`);
  apply(seconds);
}

/**
 * Where a player should start, given where the inline video was and how long the clip is.
 *
 * A clip that played to its end (a conversation's does not loop) is opened at its FIRST frame:
 * resuming on the last one would end it at once. A position past the duration is clamped away for
 * the same reason.
 */
export function resumePosition(seconds: number, duration: number): number {
  if (seconds <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return seconds;
  return seconds >= duration - END_MARGIN_SECONDS ? 0 : seconds;
}

/** Within this of the end a clip counts as finished. */
const END_MARGIN_SECONDS = 0.3;
