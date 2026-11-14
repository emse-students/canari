// @vitest-environment happy-dom
/**
 * THE DESKTOP LIVE'S CAPTURES, at the device (owner, 2026-10-31 and 2026-11-14): where the scenes are
 * offered, what the screen picker is asked (the live's size, the share's sound offered, NO microphone
 * - the live's microphone is its own capture), the microphone opened alone, and the camera's lens
 * opened alone. Every refusal is typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import {
  liveScenesAvailable,
  openLiveCamera,
  openLiveDisplay,
  openLiveMicrophone,
} from './liveDevice';
import {
  LIVE_CAPTURE_FPS,
  LIVE_CAPTURE_LONG_SIDE_PX,
  LIVE_CAPTURE_SHORT_SIDE_PX,
} from './constants';

// The microphone hold (`audioSession.ts`, pinned by `audioSession.test.ts`) is passed through: this
// file's fake streams pin what is ASKED, not the session type.
vi.mock('$lib/utils/audioSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/audioSession')>()),
  captureUserMedia: (devices: MediaDevices, constraints: MediaStreamConstraints) =>
    devices.getUserMedia(constraints),
}));

function track(kind: 'video' | 'audio') {
  return {
    kind,
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30, channelCount: 1 }),
  };
}

function streamOf(...tracks: ReturnType<typeof track>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

function stubDevices(devices: Partial<MediaDevices> | undefined) {
  vi.stubGlobal('navigator', { mediaDevices: devices, userAgent: 'test' });
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', class {});
  for (const level of ['debug', 'warn', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('liveScenesAvailable', () => {
  it('needs getDisplayMedia, an AudioContext AND a mouse: a phone keeps the camera', () => {
    stubDevices({ getDisplayMedia: vi.fn() } as unknown as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(liveScenesAvailable()).toBe(true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(liveScenesAvailable()).toBe(false);
    stubDevices({} as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(liveScenesAvailable()).toBe(false);
    stubDevices(undefined);
    expect(liveScenesAvailable()).toBe(false);
  });

  it('is not offered without an AudioContext: the scenes mix their sound', () => {
    stubDevices({ getDisplayMedia: vi.fn() } as unknown as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('AudioContext', undefined);
    expect(liveScenesAvailable()).toBe(false);
  });

  it('is never offered in the Tauri shell, mouse or not (no reliable picker)', () => {
    stubDevices({ getDisplayMedia: vi.fn() } as unknown as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), __TAURI_INTERNALS__: {} });
    expect(liveScenesAvailable()).toBe(false);
  });
});

describe('openLiveDisplay', () => {
  it("asks the picker for the live size with the share's sound offered, and asks NO microphone", async () => {
    const video = track('video');
    const shareAudio = track('audio');
    const getDisplayMedia = vi.fn(async () => streamOf(video, shareAudio));
    const getUserMedia = vi.fn();
    stubDevices({ getDisplayMedia, getUserMedia } as unknown as MediaDevices);

    const stream = await openLiveDisplay();

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
        height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
        frameRate: { ideal: LIVE_CAPTURE_FPS },
      },
      audio: true,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(stream.getVideoTracks()).toEqual([video]);
    expect(stream.getAudioTracks()).toEqual([shareAudio]);
  });

  it('a dismissed picker is a typed denial (the scene stays as it was)', async () => {
    stubDevices({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('dismissed', 'NotAllowedError');
      }),
    } as unknown as MediaDevices);
    await expect(openLiveDisplay()).rejects.toMatchObject({ fault: 'denied' });
  });

  it('an engine without getDisplayMedia answers unavailable', async () => {
    stubDevices({} as MediaDevices);
    await expect(openLiveDisplay()).rejects.toBeInstanceOf(CameraAccessError);
    await expect(openLiveDisplay()).rejects.toMatchObject({ fault: 'unavailable' });
  });
});

describe('openLiveMicrophone', () => {
  it('asks the microphone alone, mono', async () => {
    const mic = track('audio');
    const getUserMedia = vi.fn(async () => streamOf(mic));
    stubDevices({ getUserMedia } as unknown as MediaDevices);
    const stream = await openLiveMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const asked = getUserMedia.mock.calls[0] as unknown as [MediaStreamConstraints];
    expect(asked[0].video).toBeUndefined();
    expect(asked[0].audio).toMatchObject({ channelCount: { ideal: 1 } });
    expect(stream.getAudioTracks()).toEqual([mic]);
  });

  it('a refused microphone is a typed denial', async () => {
    stubDevices({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('no', 'NotAllowedError');
      }),
    } as unknown as MediaDevices);
    await expect(openLiveMicrophone()).rejects.toMatchObject({ fault: 'denied' });
  });
});

describe('openLiveCamera without the microphone', () => {
  it('asks the lens alone for a desktop live, and both for a phone', async () => {
    const getUserMedia = vi.fn(async () => streamOf(track('video')));
    stubDevices({ getUserMedia } as unknown as MediaDevices);
    await openLiveCamera('user', false, false);
    const lensOnly = getUserMedia.mock.calls[0] as unknown as [MediaStreamConstraints];
    expect(lensOnly[0].audio).toBe(false);
    await openLiveCamera('user');
    const both = getUserMedia.mock.calls[1] as unknown as [MediaStreamConstraints];
    expect(both[0].audio).toBeTruthy();
  });
});
