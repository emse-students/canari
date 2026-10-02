import { describe, it, expect } from 'vitest';
import { rememberVideoPosition, resumePosition, takeVideoPosition } from './videoResume';

describe('videoResume', () => {
  it('hands the position to the viewer once, then forgets it', () => {
    rememberVideoPosition('blob:a', 12.4);
    expect(takeVideoPosition('blob:a')).toBe(12.4);
    expect(takeVideoPosition('blob:a'), 'a second open starts at 0').toBe(0);
  });

  it('keeps each file its own position', () => {
    rememberVideoPosition('blob:a', 3);
    rememberVideoPosition('blob:b', 9);
    expect(takeVideoPosition('blob:b')).toBe(9);
    expect(takeVideoPosition('blob:a')).toBe(3);
  });

  it('forgets a position when the video is opened at its first frame', () => {
    rememberVideoPosition('blob:a', 7);
    rememberVideoPosition('blob:a', 0);
    expect(takeVideoPosition('blob:a')).toBe(0);
  });

  it('ignores a position that is not a number', () => {
    rememberVideoPosition('blob:a', Number.NaN);
    expect(takeVideoPosition('blob:a')).toBe(0);
  });

  it('knows nothing of a file that was never played inline', () => {
    expect(takeVideoPosition('blob:never')).toBe(0);
  });

  describe('resumePosition', () => {
    it('resumes in the middle of a clip', () => {
      expect(resumePosition(12, 30)).toBe(12);
    });
    it('starts a clip that played to its end over, instead of resuming on its last frame', () => {
      expect(resumePosition(30, 30)).toBe(0);
      expect(resumePosition(29.9, 30)).toBe(0);
    });
    it('starts at 0 when there is nothing to resume', () => {
      expect(resumePosition(0, 30)).toBe(0);
    });
    it('trusts the position when the duration is not known', () => {
      expect(resumePosition(5, Number.NaN)).toBe(5);
    });
  });
});
