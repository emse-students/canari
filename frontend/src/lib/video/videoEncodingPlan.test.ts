/**
 * The numbers decision C3 turns into: 720p on the short side, ~2.5 Mb/s, at most 30 fps, and a
 * byte budget that lowers the bitrate before it ever lets a file past the ceiling.
 */
import {
  AUDIO_BITRATE,
  VIDEO_BUDGET_SHARE,
  VIDEO_MIN_BITRATE,
  VIDEO_PROFILES,
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
    const rate = budgetedVideoBitrate(90, AUDIO_BITRATE, CEILING);
    expect(rate).toBe(VIDEO_TARGET_BITRATE);
    const bytes = ((rate! + AUDIO_BITRATE) * 90) / 8;
    expect(bytes / MB).toBeGreaterThan(27);
    expect(bytes / MB).toBeLessThan(30);
  });

  it('is lowered, never raised, so a long video still fits', () => {
    const rate = budgetedVideoBitrate(300, AUDIO_BITRATE, CEILING)!;
    expect(rate).toBeLessThan(VIDEO_TARGET_BITRATE);
    expect(((rate + AUDIO_BITRATE) * 300) / 8).toBeLessThanOrEqual(CEILING * VIDEO_BUDGET_SHARE);
  });

  it('refuses a video that would need less than the floor', () => {
    const seconds = (CEILING * 8 * VIDEO_BUDGET_SHARE) / (VIDEO_MIN_BITRATE + AUDIO_BITRATE) + 1;
    expect(budgetedVideoBitrate(seconds, AUDIO_BITRATE, CEILING)).toBeNull();
  });

  it('keeps the target when the ceiling is unknown - the server 413 stays the refusal', () => {
    expect(budgetedVideoBitrate(3600, AUDIO_BITRATE, undefined)).toBe(VIDEO_TARGET_BITRATE);
  });

  it('gives a silent video the audio share', () => {
    expect(budgetedVideoBitrate(400, 0, CEILING)!).toBeGreaterThan(
      budgetedVideoBitrate(400, AUDIO_BITRATE, CEILING)!
    );
  });

  it('takes a copied audio track out of the budget at its own bitrate', () => {
    // A 320 kb/s AAC-LC source is copied, not re-encoded at 128 kb/s, so it costs 320 kb/s.
    const totalPerSecond = (CEILING * 8 * VIDEO_BUDGET_SHARE) / 400;
    expect(budgetedVideoBitrate(400, 320_000, CEILING)).toBe(Math.floor(totalPerSecond - 320_000));
  });
});

describe('planVideoEncoding', () => {
  const base = {
    displayWidth: 1080,
    displayHeight: 1920,
    durationSeconds: 20,
    frameRate: 60,
    audioBitrate: AUDIO_BITRATE,
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

describe('the chat profile (D-size: about 540p at 1.2 Mb/s)', () => {
  const chat = VIDEO_PROFILES.chat;
  const source = {
    displayWidth: 1080,
    displayHeight: 1920,
    durationSeconds: 60,
    frameRate: 60,
    audioBitrate: chat.audioBitrate,
  };

  it('plans 540x960 at 1.2 Mb/s for a 1080p portrait take', () => {
    expect(planVideoEncoding(source, CEILING, chat)).toEqual({
      width: 540,
      height: 960,
      videoBitrate: 1_200_000,
      frameRate: 30,
    });
  });

  it.each([20, 60, 90])('fits maxBytes at %i s, the cap and well past it', (seconds) => {
    const plan = planVideoEncoding({ ...source, durationSeconds: seconds }, CEILING, chat);
    if (typeof plan === 'string') throw new Error(plan);
    const bytes = ((plan.videoBitrate + chat.audioBitrate) * seconds) / 8;
    expect(bytes).toBeLessThanOrEqual(CEILING * VIDEO_BUDGET_SHARE);
  });

  it('is about 9 MB at the 60 s chat cap', () => {
    const bytes = ((chat.targetBitrate + chat.audioBitrate) * 60) / 8;
    expect(bytes / MB).toBeGreaterThan(8.5);
    expect(bytes / MB).toBeLessThan(10);
  });

  it('never scales a small clip up, and is cheaper than the feed at every length', () => {
    expect(outputDimensions(480, 854, chat)).toEqual({ width: 480, height: 854 });
    const feed = ((VIDEO_PROFILES.feed.targetBitrate + AUDIO_BITRATE) * 60) / 8;
    expect(((chat.targetBitrate + chat.audioBitrate) * 60) / 8).toBeLessThan(feed / 2);
  });

  it('leaves the feed plan byte-identical: no profile is the feed profile', () => {
    const feedSource = { ...source, durationSeconds: 90, audioBitrate: AUDIO_BITRATE };
    const expected = { width: 720, height: 1280, videoBitrate: 2_500_000, frameRate: 30 };
    expect(planVideoEncoding(feedSource, CEILING)).toEqual(expected);
    expect(planVideoEncoding(feedSource, CEILING, VIDEO_PROFILES.feed)).toEqual(expected);
    expect(VIDEO_PROFILES.feed).toEqual({
      maxShortSide: 720,
      targetBitrate: 2_500_000,
      audioBitrate: 128_000,
    });
  });
});
