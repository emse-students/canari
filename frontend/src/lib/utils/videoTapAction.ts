/**
 * WHAT A TAP ON A VIDEO'S PICTURE DOES, ONE TABLE FOR EVERY PLAYER (owner, 2026-11-10).
 *
 * - **feed** (a post card's video, a CanaReel's card): the tap OPENS FULL SCREEN, and full screen is
 *   the CanaReels viewer, on that video, at the time it had reached. 1.6.9 had made the feed's tap the
 *   sound and moved full screen to the expand chip; readers disliked it - the chip still opens it, the
 *   speaker chip is the sound. A feed video with no viewer to open (none handed down) keeps the sound
 *   tap, and plays a paused video too (no play button is drawn there).
 * - **reel**, **lightbox** and **conversation** (full screen; owner, 2026-11-10, after "n'importe quel
 *   clic sur l'interface coupe le son"): THE TAP NEVER MUTES. It PLAYS or PAUSES, as TikTok, YouTube
 *   Shorts and Instagram Reels do since March 2026 (Instagram dropped tap-to-mute); a MUTED video's
 *   tap turns the sound ON instead (the autoplay-refused case). Sound goes off through the speaker or
 *   the `m` key only. A double tap (Reels: the like) calls no single tap, so it leaves playback as it
 *   was. The press held pauses - the hold is `videoGestures`'.
 * - **chat** (a conversation's inline video): the first tap plays it, audible, as its disc does; once
 *   started the tap is its sound (its pause chip pauses).
 */
export type VideoVariant = 'lightbox' | 'reel' | 'feed' | 'chat' | 'conversation';

/** What the picture's tap is answered with. */
export type VideoTapAction =
  | 'open-viewer'
  | 'toggle-play'
  | 'toggle-sound'
  /** Full screen, a muted video: the sound comes on and the controls rise. Never the other way. */
  | 'sound-on'
  /**
   * The sound, then play: a feed video on screen but paused has no button to press, and a full-screen
   * video muted AND paused gets both from one tap (its toggle can only turn the sound on).
   */
  | 'toggle-sound-and-play';

export interface VideoTapState {
  variant: VideoVariant;
  /** A viewer can be opened from here (the caller handed one down). */
  canOpen: boolean;
  /** The element is paused. */
  paused: boolean;
  /** A conversation's inline video has been played once. */
  started: boolean;
  /** The element's sound is off. */
  muted: boolean;
}

/** The answer to a tap on the picture - see the table above. Pure, so it is tested as a table. */
export function videoTapAction({
  variant,
  canOpen,
  paused,
  started,
  muted,
}: VideoTapState): VideoTapAction {
  switch (variant) {
    case 'feed':
      if (canOpen) return 'open-viewer';
      return paused ? 'toggle-sound-and-play' : 'toggle-sound';
    case 'chat':
      return started ? 'toggle-sound' : 'toggle-play';
    case 'conversation':
    case 'reel':
    case 'lightbox':
      // Muted AND paused (an autoplay refused even muted, its play disc up): ONE tap gives both,
      // never a tap for the sound and a second for the picture.
      if (muted) return paused ? 'toggle-sound-and-play' : 'sound-on';
      return 'toggle-play';
  }
}
