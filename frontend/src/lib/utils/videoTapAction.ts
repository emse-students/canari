/**
 * WHAT A TAP ON A VIDEO'S PICTURE DOES, ONE TABLE FOR EVERY PLAYER (owner, 2026-11-10).
 *
 * - **feed** (a post card's video, a CanaReel's card): the tap OPENS FULL SCREEN, and full screen is
 *   the CanaReels viewer, on that video, at the time it had reached. 1.6.9 had made the feed's tap the
 *   sound and moved full screen to the expand chip; readers disliked it - the chip still opens it, the
 *   speaker chip is the sound. A feed video with no viewer to open (none handed down) keeps the sound
 *   tap, and plays a paused video too (no play button is drawn there).
 * - **reel** and **lightbox** (full screen): the tap is the SOUND (Instagram's Reels); the press held
 *   pauses - the hold is `videoGestures`', the same everywhere.
 * - **conversation** (a conversation's media viewer, owner 2026-11-10: "minimal like the CanaReels"):
 *   the tap PAUSES or PLAYS; the speaker is its corner chip.
 * - **chat** (a conversation's inline video): the first tap plays it, audible, as its disc does; once
 *   started the tap is its sound (its pause chip pauses).
 */
export type VideoVariant = 'lightbox' | 'reel' | 'feed' | 'chat' | 'conversation';

/** What the picture's tap is answered with. */
export type VideoTapAction =
  | 'open-viewer'
  | 'toggle-play'
  | 'toggle-sound'
  /** The sound, then play: a feed video on screen but paused has no button to press. */
  | 'toggle-sound-and-play';

export interface VideoTapState {
  variant: VideoVariant;
  /** A viewer can be opened from here (the caller handed one down). */
  canOpen: boolean;
  /** The element is paused. */
  paused: boolean;
  /** A conversation's inline video has been played once. */
  started: boolean;
}

/** The answer to a tap on the picture - see the table above. Pure, so it is tested as a table. */
export function videoTapAction({
  variant,
  canOpen,
  paused,
  started,
}: VideoTapState): VideoTapAction {
  switch (variant) {
    case 'feed':
      if (canOpen) return 'open-viewer';
      return paused ? 'toggle-sound-and-play' : 'toggle-sound';
    case 'chat':
      return started ? 'toggle-sound' : 'toggle-play';
    case 'conversation':
      return 'toggle-play';
    case 'reel':
    case 'lightbox':
      return 'toggle-sound';
  }
}
