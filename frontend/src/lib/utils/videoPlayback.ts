/**
 * The arithmetic of Canari's video player (`VideoPlayer.svelte`), kept out of the component so a
 * test can state it without a media engine - happy-dom decodes nothing and has no `TimeRanges`.
 */

/** Seconds of playback after the last interaction before the controls fade (user, 2026-10-01). */
export const CONTROLS_FADE_MS = 2500;

/** How far one arrow key moves the playhead. */
export const SEEK_STEP_S = 5;

/**
 * A playhead position as the reader reads it: `m:ss`, or `h:mm:ss` past an hour.
 *
 * A duration the engine does not know yet is `NaN` or `Infinity` (a stream before its last segment),
 * and is drawn as `0:00` rather than `NaN:NaN`.
 */
export function formatVideoTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The part of `TimeRanges` this file reads, so a test can hand it a plain object. */
export interface BufferedRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * How far the buffered range that holds the playhead reaches, as a fraction of the duration.
 *
 * THE RANGE UNDER THE PLAYHEAD, NOT THE LAST ONE: after a seek the engine holds two ranges, and
 * drawing the far one's end would show bytes ahead of the reader that playback cannot reach without
 * crossing a hole. With no range under the playhead, nothing ahead of it is buffered: the fraction
 * is the playhead's own.
 */
export function bufferedFraction(
  buffered: BufferedRanges,
  currentTime: number,
  duration: number
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  let reach = currentTime;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime + 0.01 && buffered.end(i) >= currentTime) {
      reach = Math.max(reach, buffered.end(i));
    }
  }
  return clampFraction(reach / duration);
}

/** A fraction clamped to `[0, 1]`; `NaN` is `0`. */
export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** What a key does to the player, or `null` when the key is not the player's. */
export type VideoKeyAction =
  | { kind: 'toggle-play' }
  | { kind: 'seek-by'; seconds: number }
  | { kind: 'seek-to'; fraction: number }
  | { kind: 'toggle-mute' }
  | { kind: 'toggle-fullscreen' };

/**
 * The player's keyboard, the conventional one (YouTube's): space or `k` plays and pauses, the
 * arrows step by {@link SEEK_STEP_S}, `Home`/`End` jump, `m` mutes, `f` goes full screen.
 *
 * Left and right are the SEEK only when the focus is on the player: the viewer around it uses the
 * same arrows for the previous and next media, and the caller stops the event when it acts on it.
 */
export function videoKeyAction(key: string): VideoKeyAction | null {
  switch (key) {
    case ' ':
    case 'k':
    case 'K':
      return { kind: 'toggle-play' };
    case 'ArrowLeft':
      return { kind: 'seek-by', seconds: -SEEK_STEP_S };
    case 'ArrowRight':
      return { kind: 'seek-by', seconds: SEEK_STEP_S };
    case 'Home':
      return { kind: 'seek-to', fraction: 0 };
    case 'End':
      return { kind: 'seek-to', fraction: 1 };
    case 'm':
    case 'M':
      return { kind: 'toggle-mute' };
    case 'f':
    case 'F':
      return { kind: 'toggle-fullscreen' };
    default:
      return null;
  }
}
