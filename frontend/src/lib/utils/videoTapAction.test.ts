import { describe, expect, it } from 'vitest';
import { videoTapAction, type VideoTapState } from './videoTapAction';

const base: VideoTapState = {
  variant: 'feed',
  canOpen: false,
  paused: false,
  started: false,
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

  it('in full screen (reel, lightbox) a tap NEVER mutes: it plays or pauses', () => {
    for (const variant of ['reel', 'lightbox'] as const) {
      expect(videoTapAction({ ...base, variant })).toBe('toggle-play');
      expect(videoTapAction({ ...base, variant, paused: true })).toBe('toggle-play');
      expect(videoTapAction({ ...base, variant, canOpen: true })).toBe('toggle-play');
    }
  });

  it('in full screen a MUTED video tap turns the sound on', () => {
    for (const variant of ['reel', 'lightbox'] as const) {
      expect(videoTapAction({ ...base, variant, muted: true })).toBe('sound-on');
      // Muted and paused: one tap for the sound and the picture, not two.
      expect(videoTapAction({ ...base, variant, muted: true, paused: true })).toBe(
        'toggle-sound-and-play'
      );
    }
  });

  it('a conversation viewer tap pauses and plays, and a muted one turns the sound on', () => {
    expect(videoTapAction({ ...base, variant: 'conversation' })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'conversation', paused: true })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'conversation', muted: true })).toBe('sound-on');
  });

  it('a conversation inline video: the first tap plays, then the tap is the sound', () => {
    expect(videoTapAction({ ...base, variant: 'chat' })).toBe('toggle-play');
    expect(videoTapAction({ ...base, variant: 'chat', started: true })).toBe('toggle-sound');
  });
});
