/**
 * The arithmetic of a voice note's scrubber, apart from the component so it is tested without a
 * pointer: where a press lands in time, and what a key steps by.
 */

/** Seconds a left/right arrow moves the playhead by. */
const SCRUB_KEY_STEP_SECONDS = 5;

/**
 * The time a horizontal press position stands for on a strip: its fraction of the strip's width,
 * times the note's length. Clamped, because a captured drag keeps reporting positions long after the
 * finger left the strip. 0 for a strip with no width or a note with no known length.
 */
export function scrubTimeAt(
  clientX: number,
  strip: { left: number; width: number },
  duration: number
): number {
  if (!(strip.width > 0) || !(duration > 0)) return 0;
  const fraction = Math.min(1, Math.max(0, (clientX - strip.left) / strip.width));
  return fraction * duration;
}

/**
 * The time a key moves the playhead to, or `null` when the key is not the scrubber's (so the caller
 * leaves it to the page). Left/Right step, Home/End jump to the ends.
 */
export function scrubTimeForKey(key: string, current: number, duration: number): number | null {
  if (!(duration > 0)) return null;
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(current - SCRUB_KEY_STEP_SECONDS);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(current + SCRUB_KEY_STEP_SECONDS);
    case 'Home':
      return 0;
    case 'End':
      return duration;
    default:
      return null;
  }
}
