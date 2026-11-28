/**
 * The arithmetic of a voice note's scrubber, apart from the component so it is tested without a
 * pointer: where a press lands in time, what a key steps by, and where a note was left when its
 * element went away.
 */

/** Seconds a left/right arrow moves the playhead by. */
export const SCRUB_KEY_STEP_SECONDS = 5;

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

/** Where a note was left: its position, and whether it was playing. */
export interface VoiceResume {
  time: number;
  playing: boolean;
}

/**
 * THE NOTE'S PLACE OUTLIVES ITS ELEMENT. Whatever tears a bubble's player down and builds it again
 * (a virtualised list scrolling the row away, a media effect re-running, a remount of the row) used
 * to take the position with it, and the note started over from 0:00. The place is kept here, keyed
 * by the attachment (`MediaRef.mediaId`, never the blob URL a re-download changes), and read back
 * when a player for the same attachment appears. Bounded: the oldest entry goes first.
 */
const MEMORY_LIMIT = 64;
const memory = new Map<string, VoiceResume>();

/** Records where `key`'s note stands. A note at its start, paused, has nothing to remember. */
export function rememberVoicePosition(key: string, state: VoiceResume): void {
  if (!key) return;
  memory.delete(key);
  if (state.time <= 0 && !state.playing) return;
  memory.set(key, state);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
}

/** Where `key`'s note was left, or `null` when it was never played (or played to its end). */
export function recallVoicePosition(key: string): VoiceResume | null {
  return key ? (memory.get(key) ?? null) : null;
}

/** Forgets a note (it ended, or its attachment changed). */
export function forgetVoicePosition(key: string): void {
  memory.delete(key);
}
