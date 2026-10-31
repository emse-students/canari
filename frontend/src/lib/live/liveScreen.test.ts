// @vitest-environment happy-dom
/**
 * THE SCREEN AS A LIVE'S SOURCE, at the device: what is asked of the share's picker, the microphone
 * kept, the share's own audio mixed in only when the browser gave one, and the mix released with the
 * stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { openLiveScreen, screenShareAvailable } from './liveDevice';
import {
  LIVE_CAPTURE_FPS,
  LIVE_CAPTURE_LONG_SIDE_PX,
  LIVE_CAPTURE_SHORT_SIDE_PX,
} from './constants';

function track(kind: 'video' | 'audio') {
  return { kind, stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };
}

function streamOf(...tracks: ReturnType<typeof track>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

/** A MediaStream that keeps the tracks it was given, as a browser's does. */
class FakeMediaStream {
  constructor(private readonly tracks: ReturnType<typeof track>[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

const contexts: { close: ReturnType<typeof vi.fn>; mixed: ReturnType<typeof track> }[] = [];

/** What a fresh context says once resumed: `running`, or `suspended` for a browser that refuses. */
let stateAfterResume: AudioContextState = 'running';

class FakeAudioContext {
  close = vi.fn(async () => {});
  state: AudioContextState = 'suspended';
  resume = vi.fn(async () => {
    this.state = stateAfterResume;
  });
  constructor() {
    contexts.push({ close: this.close, mixed: track('audio') });
  }
  createMediaStreamDestination() {
    return { stream: new FakeMediaStream([contexts[contexts.length - 1].mixed]) };
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
}

function stubDevices(devices: Partial<MediaDevices> | undefined) {
  vi.stubGlobal('navigator', { mediaDevices: devices, userAgent: 'test' });
}

beforeEach(() => {
  contexts.length = 0;
  stateAfterResume = 'running';
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  for (const level of ['debug', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screenShareAvailable', () => {
  it('needs getDisplayMedia AND a mouse: a phone keeps the camera', () => {
    stubDevices({ getDisplayMedia: vi.fn() } as unknown as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(screenShareAvailable()).toBe(true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(screenShareAvailable()).toBe(false);
    stubDevices({} as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(screenShareAvailable()).toBe(false);
    stubDevices(undefined);
    expect(screenShareAvailable()).toBe(false);
  });

  it('is never offered in the Tauri shell, mouse or not (no reliable picker)', () => {
    stubDevices({ getDisplayMedia: vi.fn() } as unknown as MediaDevices);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), __TAURI_INTERNALS__: {} });
    expect(screenShareAvailable()).toBe(false);
  });
});

describe('openLiveScreen', () => {
  it('asks the picker for the live size, with audio offered, and keeps the microphone', async () => {
    const video = track('video');
    const mic = track('audio');
    const getDisplayMedia = vi.fn(async () => streamOf(video));
    const getUserMedia = vi.fn(async () => streamOf(mic));
    stubDevices({ getDisplayMedia, getUserMedia } as unknown as MediaDevices);

    const stream = await openLiveScreen();

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
        height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
        frameRate: { ideal: LIVE_CAPTURE_FPS },
      },
      audio: true,
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stream.getVideoTracks()).toEqual([video]);
    // No share audio: the microphone alone, and the context made for the mix is closed unused.
    expect(stream.getAudioTracks()).toEqual([mic]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it('mixes the share audio with the microphone, and releasing the stream releases the mix', async () => {
    const video = track('video');
    const shareAudio = track('audio');
    const mic = track('audio');
    stubDevices({
      getDisplayMedia: vi.fn(async () => streamOf(video, shareAudio)),
      getUserMedia: vi.fn(async () => streamOf(mic)),
    } as unknown as MediaDevices);

    const stream = await openLiveScreen();

    expect(contexts).toHaveLength(1);
    const [mixed] = stream.getAudioTracks();
    expect(mixed).toBe(contexts[0].mixed);
    for (const t of stream.getTracks()) t.stop();
    expect(video.stop).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
    expect(shareAudio.stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it('RESUMES the mixing context, and a context that stays suspended falls back to the microphone alone', async () => {
    const run = async () => {
      const video = track('video');
      const shareAudio = track('audio');
      const mic = track('audio');
      stubDevices({
        getDisplayMedia: vi.fn(async () => streamOf(video, shareAudio)),
        getUserMedia: vi.fn(async () => streamOf(mic)),
      } as unknown as MediaDevices);
      return { stream: await openLiveScreen(), shareAudio, mic };
    };
    const running = await run();
    expect(contexts).toHaveLength(1);
    expect(running.stream.getAudioTracks()).toEqual([contexts[0].mixed]);

    contexts.length = 0;
    stateAfterResume = 'suspended';
    const stuck = await run();
    expect(stuck.stream.getAudioTracks()).toEqual([stuck.mic]);
    expect(stuck.shareAudio.stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('is suspended'));
  });

  it('uses the context made inside the click, never awaits a resume that stays pending, and closes it on every exit', async () => {
    // Safari without activation: resume() never settles. Nothing may wait for it.
    const never = new FakeAudioContext();
    never.resume = vi.fn(() => new Promise<void>(() => {}));
    const given = never as unknown as AudioContext;
    const video = track('video');
    const shareAudio = track('audio');
    const mic = track('audio');
    stubDevices({
      getDisplayMedia: vi.fn(async () => streamOf(video, shareAudio)),
      getUserMedia: vi.fn(async () => streamOf(mic)),
    } as unknown as MediaDevices);
    const stream = await openLiveScreen(given);
    // Not running: the microphone alone, the context closed, no second context made.
    expect(stream.getAudioTracks()).toEqual([mic]);
    expect(never.close).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);

    // A dismissed picker closes the context it was given.
    const dismissed = new FakeAudioContext();
    stubDevices({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('no', 'NotAllowedError');
      }),
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices);
    await expect(openLiveScreen(dismissed as unknown as AudioContext)).rejects.toBeInstanceOf(
      CameraAccessError
    );
    expect(dismissed.close).toHaveBeenCalledTimes(1);
  });

  it('a dismissed picker is a typed refusal and the microphone is never asked', async () => {
    const getUserMedia = vi.fn();
    stubDevices({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('dismissed', 'NotAllowedError');
      }),
      getUserMedia,
    } as unknown as MediaDevices);
    await expect(openLiveScreen()).rejects.toMatchObject({
      name: 'CameraAccessError',
      fault: 'denied',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('a refused microphone gives the share back and is a typed refusal', async () => {
    const video = track('video');
    stubDevices({
      getDisplayMedia: vi.fn(async () => streamOf(video)),
      getUserMedia: vi.fn(async () => {
        throw new DOMException('no mic', 'NotAllowedError');
      }),
    } as unknown as MediaDevices);
    await expect(openLiveScreen()).rejects.toBeInstanceOf(CameraAccessError);
    expect(video.stop).toHaveBeenCalled();
  });

  it('an engine without getDisplayMedia is unavailable', async () => {
    stubDevices({ getUserMedia: vi.fn() } as unknown as MediaDevices);
    await expect(openLiveScreen()).rejects.toMatchObject({ fault: 'unavailable' });
  });
});
