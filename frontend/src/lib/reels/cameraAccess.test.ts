/**
 * The camera's refusals are TYPES classified where `getUserMedia` throws (CanaReels, C5). The names
 * pinned here are the ones read on the phones on 2026-10-01 (`NotAllowedError` on a refusal) plus the
 * Media Capture spec's for the two causes a phone could not be made to show on demand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CameraAccessError,
  classifyCameraError,
  openReelCamera,
  releaseCamera,
  torchSupported,
} from './cameraAccess';

function domError(name: string): DOMException {
  return new DOMException('x', name);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyCameraError', () => {
  it('reads a refusal as denied', () => {
    expect(classifyCameraError(domError('NotAllowedError'))).toBe('denied');
    expect(classifyCameraError(domError('SecurityError'))).toBe('denied');
  });

  it('reads a camera another app holds as busy', () => {
    expect(classifyCameraError(domError('NotReadableError'))).toBe('busy');
    expect(classifyCameraError(domError('AbortError'))).toBe('busy');
  });

  it('reads no camera as unavailable', () => {
    expect(classifyCameraError(domError('NotFoundError'))).toBe('unavailable');
    expect(classifyCameraError(domError('OverconstrainedError'))).toBe('unavailable');
  });

  it('reads an unknown name as unavailable and says so in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classifyCameraError(new Error('odd'))).toBe('unavailable');
    expect(warn).toHaveBeenCalled();
  });
});

describe('openReelCamera', () => {
  it('asks for both tracks, the lens and the SCREEN-sized frame, and hands back the stream', async () => {
    vi.stubGlobal('screen', { width: 393, height: 851 });
    vi.stubGlobal('devicePixelRatio', 2.75);
    const stream = { getVideoTracks: () => [{ label: 'camera 0, facing back' }] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    await expect(openReelCamera('environment')).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        facingMode: { exact: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 590 },
        frameRate: { ideal: 30 },
      },
      audio: true,
    });
  });

  it('asks the FRONT lens exactly, so iOS cannot answer the back one', async () => {
    vi.stubGlobal('screen', { width: 393, height: 851 });
    const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [{ label: 'front' }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await openReelCamera('user');
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ exact: 'user' });
  });

  it('logs an error, and does not switch, when the track reports another lens', async () => {
    vi.stubGlobal('screen', { width: 393, height: 851 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const track = { label: 'x', getSettings: () => ({ facingMode: 'environment' }) };
    const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [track] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await openReelCamera('user');
    expect(error).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('throws a typed refusal, never the engine error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getUserMedia = vi.fn().mockRejectedValue(domError('NotAllowedError'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const err = await openReelCamera('user').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraAccessError);
    expect((err as CameraAccessError).fault).toBe('denied');
  });

  it('refuses as unavailable, without a request, where there is no getUserMedia', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('navigator', {});
    const err = await openReelCamera('user').catch((e: unknown) => e);
    expect((err as CameraAccessError).fault).toBe('unavailable');
  });
});

describe('torchSupported', () => {
  it('reads the capability off the track, and a lens that does not list it has none', () => {
    const back = { getCapabilities: () => ({ torch: true }) } as unknown as MediaStreamTrack;
    const front = { getCapabilities: () => ({}) } as unknown as MediaStreamTrack;
    expect(torchSupported(back)).toBe(true);
    expect(torchSupported(front)).toBe(false);
    expect(torchSupported(undefined)).toBe(false);
  });
});

describe('releaseCamera', () => {
  it('stops every track, and a null stream is nothing to do', () => {
    const stop = vi.fn();
    releaseCamera({ getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(() => releaseCamera(null)).not.toThrow();
  });
});
