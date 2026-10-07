/**
 * What is saved is what the preview showed: the crop rectangle, the saved size, the constraints asked
 * of the camera and the bitrate that follows the pixels. All pure - no camera, no canvas.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REEL_CAPTURE_MAX_LONG_SIDE,
  REEL_RECORD_BITRATE_MAX,
  cameraVideoConstraints,
  coverCropRect,
  draw,
  framedOutputSize,
  shouldMirrorCapture,
  takeFramedPhoto,
  videoBitrateFor,
} from './framedCapture';

describe('coverCropRect', () => {
  it('cuts the SIDES of a landscape sensor frame shown in a portrait box', () => {
    // A 1280x720 sensor mode under a 9:16 preview: only the centre 405x720 is visible.
    const crop = coverCropRect({ width: 1280, height: 720 }, { width: 360, height: 640 });
    expect(crop.sh).toBe(720);
    expect(crop.sw).toBeCloseTo(405, 5);
    expect(crop.sx).toBeCloseTo((1280 - 405) / 2, 5);
    expect(crop.sy).toBe(0);
  });

  it('cuts the TOP AND BOTTOM of a frame taller than the box', () => {
    // 720x1280 (9:16) under a 360x540 (2:3) box: the whole width, the middle 1080 rows.
    const crop = coverCropRect({ width: 720, height: 1280 }, { width: 360, height: 540 });
    expect(crop).toEqual({ sx: 0, sy: 100, sw: 720, sh: 1080 });
  });

  it('cuts the sides of a 9:16 frame shown on a tall 393x851 phone', () => {
    // The Mi 9T case: the phone is TALLER than the sensor's 9:16, so the sides go.
    const crop = coverCropRect({ width: 720, height: 1280 }, { width: 393, height: 851 });
    expect(crop.sh).toBe(1280);
    expect(crop.sw).toBeCloseTo(591.116, 2);
    expect(crop.sy).toBe(0);
  });

  it('keeps the whole frame when the aspects already agree', () => {
    expect(coverCropRect({ width: 720, height: 1280 }, { width: 360, height: 640 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 720,
      sh: 1280,
    });
  });

  it('always has the box aspect, which is what makes the saved file the preview', () => {
    for (const src of [
      { width: 1280, height: 720 },
      { width: 720, height: 1280 },
      { width: 640, height: 480 },
    ]) {
      const box = { width: 411, height: 914 };
      const crop = coverCropRect(src, box);
      expect(crop.sw / crop.sh).toBeCloseTo(box.width / box.height, 9);
      expect(crop.sx).toBeGreaterThanOrEqual(0);
      expect(crop.sy).toBeGreaterThanOrEqual(0);
      expect(crop.sx + crop.sw).toBeLessThanOrEqual(src.width + 1e-9);
      expect(crop.sy + crop.sh).toBeLessThanOrEqual(src.height + 1e-9);
    }
  });

  it('refuses a degenerate size instead of drawing NaN', () => {
    expect(() => coverCropRect({ width: 0, height: 720 }, { width: 1, height: 1 })).toThrow(
      RangeError
    );
    expect(() => coverCropRect({ width: 1, height: 1 }, { width: 1, height: 0 })).toThrow(
      RangeError
    );
  });
});

describe('framedOutputSize', () => {
  const box = { width: 393, height: 851 };

  it('is the screen in pixels, capped, in the box aspect, with even sides', () => {
    // dpr 2.75 would be 1081x2340; the cap makes the long side 1280.
    const crop = coverCropRect({ width: 1080, height: 2400 }, box);
    const out = framedOutputSize(box, 2.75, crop);
    expect(out.height).toBe(REEL_CAPTURE_MAX_LONG_SIDE);
    expect(out.width % 2).toBe(0);
    expect(out.width / out.height).toBeCloseTo(box.width / box.height, 2);
  });

  it('never exceeds the screen: a dpr of 1 on a 393x851 box stays at 851 high', () => {
    const crop = coverCropRect({ width: 1080, height: 2400 }, box);
    expect(framedOutputSize(box, 1, crop).height).toBe(850);
  });

  it('never upscales past what the crop holds', () => {
    const crop = coverCropRect({ width: 720, height: 1280 }, box);
    const out = framedOutputSize(box, 3, crop);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(
      Math.ceil(Math.max(crop.sw, crop.sh))
    );
  });

  it('keeps a landscape box landscape', () => {
    const out = framedOutputSize(
      { width: 800, height: 400 },
      2,
      coverCropRect({ width: 1280, height: 720 }, { width: 800, height: 400 })
    );
    expect(out.width).toBeGreaterThan(out.height);
  });
});

describe('cameraVideoConstraints', () => {
  it('asks for the screen, capped, stated landscape as sensors list their modes', () => {
    // A Mi 9T: 393x851 CSS pixels at 2.75 (1080x2340 physical).
    expect(cameraVideoConstraints({ width: 393, height: 851 }, 2.75)).toEqual({
      width: 1280,
      height: 590,
      frameRate: 30,
    });
  });

  it('asks for LESS than the cap on a small screen, never more than it can show', () => {
    expect(cameraVideoConstraints({ width: 320, height: 568 }, 1)).toEqual({
      width: 568,
      height: 320,
      frameRate: 30,
    });
  });

  it('is the same for a screen reported in either orientation', () => {
    expect(cameraVideoConstraints({ width: 851, height: 393 }, 2.75)).toEqual(
      cameraVideoConstraints({ width: 393, height: 851 }, 2.75)
    );
  });
});

describe('videoBitrateFor', () => {
  it('is the cap at 720x1280 and above', () => {
    expect(videoBitrateFor({ width: 720, height: 1280 })).toBe(REEL_RECORD_BITRATE_MAX);
    expect(videoBitrateFor({ width: 1080, height: 1920 })).toBe(REEL_RECORD_BITRATE_MAX);
  });

  it('follows the pixels on a smaller frame', () => {
    const small = videoBitrateFor({ width: 360, height: 640 });
    expect(small).toBeLessThan(REEL_RECORD_BITRATE_MAX);
    expect(small).toBe(Math.round(360 * 640 * 30 * 0.15));
  });
});

describe('mirroring of the capture', () => {
  it('mirrors exactly the lens whose preview is mirrored', () => {
    expect(shouldMirrorCapture('user')).toBe(true);
    expect(shouldMirrorCapture('environment')).toBe(false);
  });

  function recordingContext() {
    const calls: string[] = [];
    const context = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: (x: number, y: number) => calls.push(`translate ${x} ${y}`),
      scale: (x: number, y: number) => calls.push(`scale ${x} ${y}`),
      drawImage: () => calls.push('drawImage'),
    } as unknown as CanvasRenderingContext2D;
    return { calls, context };
  }
  const crop = { sx: 0, sy: 0, sw: 720, sh: 1280 };
  const out = { width: 360, height: 640 };
  const video = {} as HTMLVideoElement;

  it('flips horizontally around the frame width, draws, then undoes the flip', () => {
    const { calls, context } = recordingContext();
    draw(context, video, crop, out, true);
    expect(calls).toEqual(['save', 'translate 360 0', 'scale -1 1', 'drawImage', 'restore']);
  });

  it('draws the rear lens untouched', () => {
    const { calls, context } = recordingContext();
    draw(context, video, crop, out, false);
    expect(calls).toEqual(['drawImage']);
  });
});

describe('takeFramedPhoto', () => {
  it('encodes synchronously, never through the idle-scheduled toBlob (4 s on the Android WebView)', async () => {
    const toBlob = vi.fn();
    const toDataURL = vi.fn(() => `data:image/jpeg;base64,${btoa('jpeg')}`);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(),
      }),
      toBlob,
      toDataURL,
    };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(canvas as unknown as HTMLElement);
    const video = { videoWidth: 590, videoHeight: 1280 } as HTMLVideoElement;
    const blob = await takeFramedPhoto(video, { width: 393, height: 851, dpr: 2.75, mirror: true });
    expect(blob?.type).toBe('image/jpeg');
    expect(blob?.size).toBe(4);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.92);
    expect(toBlob).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
