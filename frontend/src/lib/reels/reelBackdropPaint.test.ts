/** The backdrop's blur: one read of the media, then canvas-to-canvas doublings into the target. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKDROP_SAMPLE_WIDTH,
  BACKDROP_UPSCALE_STEPS,
  backdropSampleSize,
  isBlankSample,
  paintBlurredBackdrop,
} from './reelBackdropPaint';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backdropSampleSize', () => {
  it('keeps the source shape at the sample width', () => {
    expect(backdropSampleSize(720, 1280)).toEqual({ width: BACKDROP_SAMPLE_WIDTH, height: 21 });
    expect(backdropSampleSize(1920, 1080)).toEqual({ width: BACKDROP_SAMPLE_WIDTH, height: 7 });
  });

  it('never returns a zero height', () => {
    expect(backdropSampleSize(10_000, 1).height).toBe(1);
  });
});

describe('isBlankSample', () => {
  it('is blank when every colour channel is 0, whatever the alpha', () => {
    expect(isBlankSample([0, 0, 0, 255, 0, 0, 0, 0])).toBe(true);
  });

  it('is not blank as soon as one channel carries light, however dark', () => {
    expect(isBlankSample([0, 0, 0, 255, 0, 1, 0, 255])).toBe(false);
  });
});

/** A 2D context recording what is drawn, whose read-back answers `pixel` everywhere. */
function stubContext(pixel: number[]) {
  const draws: unknown[] = [];
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage: (source: unknown) => draws.push(source),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: Array.from({ length: w * h }, () => pixel).flat(),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  );
  return draws;
}

function portraitImage(): HTMLImageElement {
  const image = document.createElement('img');
  Object.defineProperty(image, 'naturalWidth', { get: () => 720 });
  Object.defineProperty(image, 'naturalHeight', { get: () => 1280 });
  return image;
}

describe('paintBlurredBackdrop', () => {
  it('draws nothing for a media with no picture size yet', () => {
    const target = document.createElement('canvas');
    expect(paintBlurredBackdrop(target, document.createElement('img'))).toBe('no-size');
  });

  it('reads the media once and leaves the target at the final blur size', () => {
    const draws = stubContext([40, 30, 20, 255]);
    const image = portraitImage();
    const target = document.createElement('canvas');

    expect(paintBlurredBackdrop(target, image)).toBe('painted');
    const scale = 2 ** BACKDROP_UPSCALE_STEPS;
    expect([target.width, target.height]).toEqual([BACKDROP_SAMPLE_WIDTH * scale, 21 * scale]);
    expect(draws.filter((d) => d === image)).toHaveLength(1);
    expect(draws).toHaveLength(1 + BACKDROP_UPSCALE_STEPS);
  });

  it('leaves the target untouched when the read is blank', () => {
    const draws = stubContext([0, 0, 0, 255]);
    const target = document.createElement('canvas');
    expect(paintBlurredBackdrop(target, portraitImage())).toBe('blank');
    expect(draws).toHaveLength(1);
    expect([target.width, target.height]).toEqual([300, 150]);
  });
});
