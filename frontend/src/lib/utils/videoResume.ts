import { Log } from '$lib/utils/Log';

/**
 * OPENING A VIDEO FULL SCREEN PICKS UP WHERE IT IS (user, 2026-10-02: *"ouvrir une video en grand
 * devrait reprendre la ou elle en est, pas au debut"*).
 *
 * The inline video and the viewer's player are two `<video>` elements, so the viewer started at 0 -
 * a clip watched to 0:12 in the conversation began again from its first frame. Several places open
 * the viewer from an inline video (a chat bubble, a post, a post's gallery, a reel), so the position
 * does not travel as a prop through each of them: `InlineVideo` writes it here at the moment of
 * opening, and the viewer's `VideoPlayer` reads it when it mounts. THE KEY IS THE MEDIA URL - both
 * are handed the same decrypted blob URL - and a position is TAKEN, not read: once the viewer has it,
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
