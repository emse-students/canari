/**
 * The numbers decision C3 turns into: 720p on the short side, ~2.5 Mb/s, at most 30 fps, and a
 * byte budget that lowers the bitrate before it ever lets a file past the ceiling.
 */
import {
  AUDIO_BITRATE,
  VIDEO_BUDGET_SHARE,
  VIDEO_MIN_BITRATE,
  VIDEO_TARGET_BITRATE,
  budgetedVideoBitrate,
  outputDimensions,
  planVideoEncoding,
} from './videoEncodingPlan';

const MB = 1024 * 1024;
/** The production ceiling as `uploadLimits` hands it over: 50 MB minus the segmented overhead. */
const CEILING = 50 * MB - 820;

describe('outputDimensions', () => {
  it.each([
    ['a 1080p landscape clip', 1920, 1080, 1280, 720],
    ['a 1080p portrait clip (rotation applied)', 1080, 1920, 720, 1280],
    ['a 4K portrait clip', 2160, 3840, 720, 1280],
    ['a 720p clip, untouched', 1280, 720, 1280, 720],
    ['a small clip, never scaled up', 640, 360, 640, 360],
    ['odd sides, made even', 721, 1281, 720, 1278],
  ])('%s', (_label, w, h, ow, oh) => {
    expect(outputDimensions(w, h)).toEqual({ width: ow, height: oh });
  });
});

describe('budgetedVideoBitrate', () => {
  it('is the C3 target for a 90 s reel - about 28 MB, under the ceiling', () => {
    const rate = budgetedVideoBitrate(90, true, CEILING);
    expect(rate).toBe(VIDEO_TARGET_BITRATE);
    const bytes = ((rate! + AUDIO_BITRATE) * 90) / 8;
    expect(bytes / MB).toBeGreaterThan(27);
    expect(bytes / MB).toBeLessThan(30);
  });

  it('is lowered, never raised, so a long video still fits', () => {
    const rate = budgetedVideoBitrate(300, true, CEILING)!;
    expect(rate).toBeLessThan(VIDEO_TARGET_BITRATE);
    expect(((rate + AUDIO_BITRATE) * 300) / 8).toBeLessThanOrEqual(CEILING * VIDEO_BUDGET_SHARE);
  });

  it('refuses a video that would need less than the floor', () => {
    const seconds = (CEILING * 8 * VIDEO_BUDGET_SHARE) / (VIDEO_MIN_BITRATE + AUDIO_BITRATE) + 1;
    expect(budgetedVideoBitrate(seconds, true, CEILING)).toBeNull();
  });

  it('keeps the target when the ceiling is unknown - the server 413 stays the refusal', () => {
    expect(budgetedVideoBitrate(3600, true, undefined)).toBe(VIDEO_TARGET_BITRATE);
  });

  it('gives a silent video the audio share', () => {
    expect(budgetedVideoBitrate(400, false, CEILING)!).toBeGreaterThan(
      budgetedVideoBitrate(400, true, CEILING)!
    );
  });
});

describe('planVideoEncoding', () => {
  const base = {
    displayWidth: 1080,
    displayHeight: 1920,
    durationSeconds: 20,
    frameRate: 60,
    hasAudio: true,
  };

  it('resamples 60 fps to 30 and leaves 30 alone', () => {
    expect(planVideoEncoding(base, CEILING)).toEqual({
      width: 720,
      height: 1280,
      videoBitrate: VIDEO_TARGET_BITRATE,
      frameRate: 30,
    });
    expect(planVideoEncoding({ ...base, frameRate: 30.02 }, CEILING)).toMatchObject({
      frameRate: undefined,
    });
  });

  it('names why no plan exists', () => {
    expect(planVideoEncoding({ ...base, displayWidth: 0 }, CEILING)).toBe('no-dimensions');
    expect(planVideoEncoding({ ...base, durationSeconds: 3 * 3600 }, CEILING)).toBe('too-long');
  });
});
