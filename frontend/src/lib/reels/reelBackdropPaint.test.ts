/** The backdrop's blur: one read of the media, then canvas-to-canvas doublings into the target. */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKDROP_SAMPLE_WIDTH,
  BACKDROP_UPSCALE_STEPS,
  backdropSampleSize,
  paintBlurredBackdrop,
} from './reelBackdropPaint';

describe('backdropSampleSize', () => {
  it('keeps the source shape at the sample width', () => {
    expect(backdropSampleSize(720, 1280)).toEqual({ width: BACKDROP_SAMPLE_WIDTH, height: 21 });
    expect(backdropSampleSize(1920, 1080)).toEqual({ width: BACKDROP_SAMPLE_WIDTH, height: 7 });
  });

  it('never returns a zero height', () => {
    expect(backdropSampleSize(10_000, 1).height).toBe(1);
  });
});

describe('paintBlurredBackdrop', () => {
  it('draws nothing for a media with no picture size yet', () => {
    const target = document.createElement('canvas');
    const image = document.createElement('img');
    expect(paintBlurredBackdrop(target, image)).toBe(false);
  });

  it('reads the media once and leaves the target at the final blur size', () => {
    const draws: unknown[] = [];
    const ctx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: (source: unknown) => draws.push(source),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { get: () => 720 });
    Object.defineProperty(image, 'naturalHeight', { get: () => 1280 });
    const target = document.createElement('canvas');

    expect(paintBlurredBackdrop(target, image)).toBe(true);
    const scale = 2 ** BACKDROP_UPSCALE_STEPS;
    expect([target.width, target.height]).toEqual([BACKDROP_SAMPLE_WIDTH * scale, 21 * scale]);
    expect(draws.filter((d) => d === image)).toHaveLength(1);
    expect(draws).toHaveLength(1 + BACKDROP_UPSCALE_STEPS);
    vi.restoreAllMocks();
  });
});
