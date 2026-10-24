// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { captureVideoFrame } from './videoFrameBackdrop';

describe('captureVideoFrame', () => {
  it('returns null while the element holds no decoded frame', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    expect(captureVideoFrame(video)).toBeNull();
  });

  it('draws the element once into a 48 px-wide canvas at the clip ratio', () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => 'data:image/jpeg;base64,x',
    };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(canvas as never);
    const video = { videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement;
    expect(captureVideoFrame(video)).toBe('data:image/jpeg;base64,x');
    expect(canvas.width).toBe(48);
    expect(canvas.height).toBe(85);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it('returns null, logged, when the engine refuses the read', () => {
    const canvas = {
      getContext: () => ({
        drawImage: () => {
          throw new DOMException('tainted', 'SecurityError');
        },
      }),
    };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(canvas as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(captureVideoFrame({ videoWidth: 10, videoHeight: 10 } as HTMLVideoElement)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
