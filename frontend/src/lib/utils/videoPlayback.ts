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
 * A WHOLE LOCAL FILE's length: the engine's duration, else the end of what it can seek (every byte is
 * here, so that end is the total). Used by {@link barLength} for `streamed` false ONLY - a stream's
 * seekable end is what has loaded, which grows. `0` when neither is known.
 */
export function scrubLength(duration: number, seekable: BufferedRanges): number {
  if (Number.isFinite(duration) && duration > 0) return duration;
  if (seekable.length === 0) return 0;
  const end = seekable.end(seekable.length - 1);
  return Number.isFinite(end) && end > 0 ? end : 0;
}

/** Where a seek line's length came from (`barLength`). */
export type BarLengthSource = 'engine' | 'declared' | 'seekable' | 'unknown';

/**
 * THE LENGTH THE SEEK LINE IS FIXED TO, FROM THE FIRST FRAME (owner, 2026-11-18: on a slow link the
 * line "went back" while segments loaded). It is the TOTAL duration of the video, in this order:
 * 1. the engine's `duration` (never below the declared length), when it knows one (a file's own header, or what the stream's source was
 *    given: the declared length, then the length read from the file's tail);
 * 2. the length its PUBLISHER declared (`declaredSeconds`: a CanaReel's `posts.duration_ms`, a
 *    conversation reel's `MediaRef.durationMs`);
 * 3. a whole local file's seekable end (`streamed` false): every byte is already here, so that end
 *    IS the total and it cannot grow;
 * 4. otherwise `unknown`, `seconds` 0 - the STREAM whose total nobody has told yet. NEVER the seekable
 *    end of a stream: that is the loaded part, which grows with every segment and rewinds the line.
 *    The caller draws no played part for `unknown` and says so (`data-video-length`).
 */
export function barLength(input: {
  duration: number;
  declaredSeconds?: number | null;
  seekable: BufferedRanges;
  streamed: boolean;
}): { seconds: number; source: BarLengthSource } {
  const { duration, declaredSeconds, seekable, streamed } = input;
  if (Number.isFinite(duration) && duration > 0) {
    // The LARGER of the engine's real duration and the declared one: a declaration slightly short of the
    // media would otherwise be overtaken when the engine's duration grows at the last append, and the
    // played fraction would drop at the very end.
    const declared = declaredSeconds && Number.isFinite(declaredSeconds) ? declaredSeconds : 0;
    return { seconds: Math.max(duration, declared), source: 'engine' };
  }
  if (declaredSeconds && Number.isFinite(declaredSeconds) && declaredSeconds > 0) {
    return { seconds: declaredSeconds, source: 'declared' };
  }
  if (!streamed) {
    const local = scrubLength(duration, seekable);
    if (local > 0) return { seconds: local, source: 'seekable' };
  }
  return { seconds: 0, source: 'unknown' };
}

/** One loaded stretch of the video, as fractions of its length. */
export interface LoadedSpan {
  from: number;
  to: number;
}

/**
 * EVERY LOADED RANGE, as the grey part of the line (YouTube's): after a seek the engine holds
 * several, and each is drawn where it lies, under the played part. Clamped to the length, and
 * empty when the length is unknown - a fraction of nothing is not drawn.
 */
export function loadedSpans(buffered: BufferedRanges, length: number): LoadedSpan[] {
  if (!Number.isFinite(length) || length <= 0) return [];
  const spans: LoadedSpan[] = [];
  for (let i = 0; i < buffered.length; i++) {
    const from = clampFraction(buffered.start(i) / length);
    const to = clampFraction(buffered.end(i) / length);
    if (to > from) spans.push({ from, to });
  }
  return spans;
}

/** How much of the line is played: `currentTime` over the fixed `length`; 0 while the length is unknown. */
export function playedFraction(currentTime: number, length: number): number {
  return Number.isFinite(length) && length > 0 ? clampFraction(currentTime / length) : 0;
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
