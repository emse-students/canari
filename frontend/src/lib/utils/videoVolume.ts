/**
 * THE ONE PLACE THE APP'S VOLUME LEVEL TOUCHES `HTMLMediaElement.volume` (owner, 2026-11-11).
 *
 * Every write of the level to an element and every read of it back (a native control's
 * `volumechange`) goes through these two functions, so a later layer that scales the element's gain
 * (the loudness fallback lowering a loud video) changes ONE place: write `elementVolumeFor(video,
 * level)` in {@link applyVideoLevel} and divide by the same factor in {@link readVideoLevel}.
 */

/** Puts `video` at the app's `level` (a fraction in (0, 1]); a no-op when it already is. */
export function applyVideoLevel(video: HTMLVideoElement, level: number): void {
  if (video.volume !== level) video.volume = level;
}

/** The app's level a native control just set on `video` (the inverse of {@link applyVideoLevel}). */
export function readVideoLevel(video: HTMLVideoElement): number {
  return video.volume;
}
