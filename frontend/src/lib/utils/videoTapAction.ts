/**
 * WHAT A TAP ON A VIDEO'S PICTURE DOES, ONE TABLE FOR EVERY PLAYER (owner, 2026-11-10).
 *
 * - **feed** (a post card's video, a CanaReel's card): the tap OPENS FULL SCREEN, and full screen is
 *   the CanaReels viewer, on that video, at the time it had reached. 1.6.9 had made the feed's tap the
 *   sound and moved full screen to an expand chip; readers disliked it - the chip is gone (2026-11-10,
 *   and the chat's 2026-11-15), the speaker is the sound. A feed video with no viewer to open (none handed down) keeps the sound
 *   tap, and plays a paused video too (no play button is drawn there).
 * - **reel** (the CanaReels viewer; owner, 2026-11-18): THE TAP IS NOT THE PLAYER'S. A single tap hides or
 *   shows the viewer's overlay (`actions/reelOverlayTap.ts`, on the slide) and never pauses - the only pause
 *   is a press held on the picture. The player answers it only where there is a start to give: an
 *   autoplay the engine REFUSED leaves the video paused with its play disc up, and a tap plays it (and
 *   gives the sound if it was muted). A video that is playing, muted or not, is left alone: its sound is
 *   the rail's speaker. **Supersedes** the reel rows below for this variant.
 * - **lightbox** and **conversation** (full screen; owner, 2026-11-10, after "n'importe quel
 *   clic sur l'interface coupe le son"): THE TAP NEVER MUTES. It PLAYS or PAUSES, as TikTok, YouTube
 *   Shorts and Instagram Reels do since March 2026 (Instagram dropped tap-to-mute); a MUTED video's
 *   tap turns the sound ON instead (the autoplay-refused case). Sound goes off through the speaker or
 *   the `m` key only. A double tap (Reels: the like) calls no single tap, so it leaves playback as it
 *   was. The press held pauses - the hold is `videoGestures`'.
 * - **chat** (a conversation's inline video; owner, 2026-11-15, "Ouvrir le plein ecran"): THE TAP OPENS
 *   THE CONVERSATION VIEWER, exactly as a feed post's does, and never touches the sound (it used to be
 *   the sound once started - SUPERSEDED). The inline video is played by its own play glyph, paused
 *   by a hold, and its sound is the speaker's alone. With no viewer to open (none handed down) the
 *   tap plays or pauses it.
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
  | 'toggle-sound-and-play'
  /** The picture's tap is another layer's (the reel viewer's overlay): the player does nothing. */
  | 'none';

export interface VideoTapState {
  variant: VideoVariant;
  /** A viewer can be opened from here (the caller handed one down). */
  canOpen: boolean;
  /** The element is paused. */
  paused: boolean;
  /** The element's sound is off. */
  muted: boolean;
  /** The autoplay was refused or failed and the reader must start the video (`reel` only reads it). */
  autoplayRefused?: boolean;
}

/** The answer to a tap on the picture - see the table above. Pure, so it is tested as a table. */
export function videoTapAction({
  variant,
  canOpen,
  paused,
  muted,
  autoplayRefused = false,
}: VideoTapState): VideoTapAction {
  switch (variant) {
    case 'feed':
      if (canOpen) return 'open-viewer';
      return paused ? 'toggle-sound-and-play' : 'toggle-sound';
    case 'chat':
      return canOpen ? 'open-viewer' : 'toggle-play';
    case 'reel':
      // A video that is PLAYING is left alone. One that is PAUSED without a hold (a refused autoplay, an
      // interruption: a call, audio focus, a headset) has no other way back, so the tap restarts it -
      // it never pauses, which is what the rule forbids.
      if (!paused && !autoplayRefused) return 'none';
      return muted ? 'toggle-sound-and-play' : 'toggle-play';
    case 'conversation':
    case 'lightbox':
      // Muted AND paused (an autoplay refused even muted, its play disc up): ONE tap gives both,
      // never a tap for the sound and a second for the picture.
      if (muted) return paused ? 'toggle-sound-and-play' : 'sound-on';
      return 'toggle-play';
  }
}
