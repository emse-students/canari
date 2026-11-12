/**
 * THE ONE PLACE THE APP'S VOLUME LEVEL TOUCHES `HTMLMediaElement.volume` (owner, 2026-11-11).
 *
 * Every write of the level to an element and every read of it back (a native control's
 * `volumechange`) goes through these two functions. ONE rule decides each element's volume: the
 * reader's level TIMES the loudness factor the fallback put on that element (a loud video lowered
 * through its volume where Web Audio is not used - a WebKit stream, an engine with no Web Audio,
 * `loudnessPlayback.ts`), and the read divides that factor back out, so the reader's level is never
 * mistaken for the attenuation. On the Web Audio route the factor is 1 and the gain is the graph's.
 */
import { elementVolumeFor, readerLevelOf } from '$lib/video/loudnessPlayback';

/** Puts `video` at the app's `level` (a fraction in (0, 1]); a no-op when it already is. */
export function applyVideoLevel(video: HTMLVideoElement, level: number): void {
  const volume = elementVolumeFor(video, level);
  if (video.volume !== volume) video.volume = volume;
}

/** The app's level a native control just set on `video` (the inverse of {@link applyVideoLevel}). */
export function readVideoLevel(video: HTMLVideoElement): number {
  return readerLevelOf(video);
}
