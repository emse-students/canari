import { describe, expect, it } from 'vitest';
import { videoTapAction, type VideoTapState } from './videoTapAction';

const base: VideoTapState = {
  variant: 'feed',
  canOpen: false,
  paused: false,
  muted: false,
};

describe('videoTapAction - the owner decisions of 2026-11-10', () => {
  it('a feed tap opens full screen (the CanaReels viewer), playing or paused', () => {
    expect(videoTapAction({ ...base, canOpen: true })).toBe('open-viewer');
    expect(videoTapAction({ ...base, canOpen: true, paused: true })).toBe('open-viewer');
  });

  it('a feed video with no viewer keeps the sound tap, and plays a paused one', () => {
    expect(videoTapAction(base)).toBe('toggle-sound');
    expect(videoTapAction({ ...base, paused: true })).toBe('toggle-sound-and-play');
  });

  it('in the lightbox a tap NEVER mutes: it plays or pauses', () => {
    const variant = 'lightbox';
    expect(videoTapAction({ ...base, variant })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant, paused: true })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant, canOpen: true })).toBe('toggle-play');
  });

  it('in the lightbox a MUTED video tap turns the sound on', () => {
    const variant = 'lightbox';
    expect(videoTapAction({ ...base, variant, muted: true })).toBe('sound-on');
    // Muted and paused: one tap for the sound and the picture, not two.
    expect(videoTapAction({ ...base, variant, muted: true, paused: true })).toBe(
      'toggle-sound-and-play'
    );
  });

  it("a CanaReel tap is the overlay's, never the player's: it does not pause or mute (owner, 2026-11-18)", () => {
    const variant = 'reel';
    for (const muted of [false, true]) {
      expect(videoTapAction({ ...base, variant, paused: false, muted })).toBe('none');
    }
  });

  it('a CanaReel paused by something other than a hold (an interruption) is restarted by a tap, never paused', () => {
    expect(videoTapAction({ ...base, variant: 'reel', paused: true })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'reel', paused: false })).toBe('none');
  });

  it('a CanaReel whose autoplay was refused is started by a tap, with its sound if it was muted', () => {
    const variant = 'reel';
    expect(videoTapAction({ ...base, variant, paused: true, autoplayRefused: true })).toBe(
      'toggle-play'
    );
    expect(
      videoTapAction({ ...base, variant, paused: true, muted: true, autoplayRefused: true })
    ).toBe('toggle-sound-and-play');
  });

  it('a conversation viewer tap pauses and plays, and a muted one turns the sound on', () => {
    expect(videoTapAction({ ...base, variant: 'conversation' })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'conversation', paused: true })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'conversation', muted: true })).toBe('sound-on');
  });

  it('a conversation inline video: the tap opens the viewer and never the sound (owner, 2026-11-15)', () => {
    for (const paused of [false, true]) {
      for (const muted of [false, true]) {
        expect(videoTapAction({ ...base, variant: 'chat', canOpen: true, paused, muted })).toBe(
          'open-viewer'
        );
      }
    }
  });

  it('a conversation inline video with no viewer plays or pauses, never the sound', () => {
    expect(videoTapAction({ ...base, variant: 'chat' })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'chat', paused: true })).toBe('toggle-play');
  });
});
