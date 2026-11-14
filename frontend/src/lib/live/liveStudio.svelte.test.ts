/**
 * THE DESKTOP STUDIO (owner, 2026-11-14) on fakes: scenes switched in one click, the picker opened
 * only by a scene that needs it and only once, a dismissed picker changing nothing, a share stopped
 * from the browser turning into `pause`, the two switches that never stop a recorded track - and ONE
 * recorded stream for the studio's whole life.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { fakeCamera } from './liveBroadcast.test-helper';
import { FakeMediaStream, studioOn } from './liveStudio.test-helper';

async function opened() {
  const cam = fakeCamera();
  const s = studioOn(cam.session);
  await cam.session.start();
  await s.studio.open();
  return { ...s, cam };
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  for (const level of ['debug', 'log', 'info', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LiveStudio - the sources', () => {
  it('opens the camera WITHOUT its microphone and the microphone on its own, then draws', async () => {
    const { studio, deps, compositor, mixer, mics, cam } = await opened();
    expect(cam.control.opened).toHaveLength(0); // the session now opens through the studio's opener
    expect(deps.cameraOpener).toHaveBeenCalledTimes(1);
    expect(compositor.start).toHaveBeenCalled();
    expect(studio.micPhase).toBe('live');
    expect(studio.ready).toBe(true);
    expect(mixer.mic).toBe(mics[0].audio);
  });

  it('records ONE stream for its whole life: the composed picture and the mixed sound', async () => {
    const { studio, compositor, mixer } = await opened();
    const stream = studio.stream;
    expect(stream.getTracks()).toEqual([compositor.track, mixer.track]);
    expect(studio.previewStream.getTracks()).toEqual([compositor.track]);
    await studio.selectScene('screen');
    await studio.selectScene('pause');
    studio.toggleCamera();
    studio.toggleMic();
    expect(studio.stream).toBe(stream);
    expect(stream.getTracks()).toEqual([compositor.track, mixer.track]);
  });

  it('a refused microphone is not ready, and its Retry opens it again', async () => {
    const cam = fakeCamera();
    const s = studioOn(cam.session);
    s.control.micFailure = new CameraAccessError('denied', 'no');
    await s.studio.open();
    expect(s.studio.micPhase).toBe('error');
    expect(s.studio.micFault).toBe('denied');
    expect(s.studio.ready).toBe(false);
    await s.studio.reopenMicrophone();
    expect(s.studio.ready).toBe(true);
  });

  it('a microphone that ends mid-live is disconnected and offered back; the new one feeds the mixer', async () => {
    const { studio, mixer, mics } = await opened();
    mics[0].audio.end();
    expect(studio.micPhase).toBe('error');
    expect(studio.micFault).toBe('interrupted');
    expect(mixer.mic).toBeNull();
    await studio.reopenMicrophone();
    expect(mixer.mic).toBe(mics[1].audio);
  });
});

describe('LiveStudio - the scenes', () => {
  it('switches at once to a scene that needs no screen, and never opens the picker for it', async () => {
    const { studio, deps, compositor } = await opened();
    await studio.selectScene('pause');
    expect(studio.scene).toBe('pause');
    expect(compositor.scene).toBe('pause');
    await studio.selectScene('camera');
    expect(studio.scene).toBe('camera');
    expect(deps.openDisplay).not.toHaveBeenCalled();
  });

  it('opens the picker for the FIRST screen scene only, then reuses the screen', async () => {
    const { studio, deps, compositor, mixer, screens } = await opened();
    await studio.selectScene('screen');
    expect(studio.scene).toBe('screen');
    expect(studio.screen).toBe(screens[0].stream);
    await studio.selectScene('camera');
    await studio.selectScene('screen-camera');
    await studio.selectScene('side-by-side');
    expect(deps.openDisplay).toHaveBeenCalledTimes(1);
    expect(compositor.scene).toBe('side-by-side');
    expect(mixer.share).toBe(screens[0].audio);
  });

  it('wakes the sound SYNCHRONOUSLY in the click, before the picker is awaited', async () => {
    const { studio, mixer } = await opened();
    mixer.state = 'suspended';
    const choosing = studio.selectScene('screen');
    expect(mixer.wake).toHaveBeenCalled();
    expect(studio.choosingScreen).toBe(true);
    await choosing;
    expect(studio.choosingScreen).toBe(false);
  });

  it('a dismissed picker leaves the scene as it was, and the next click asks again', async () => {
    const { studio, deps, control } = await opened();
    await studio.selectScene('pause');
    control.screenFailure = new CameraAccessError('denied', 'dismissed');
    await studio.selectScene('screen');
    expect(studio.scene).toBe('pause');
    expect(studio.screen).toBeNull();
    expect(studio.choosingScreen).toBe(false);
    await studio.selectScene('screen');
    expect(studio.scene).toBe('screen');
    expect(deps.openDisplay).toHaveBeenCalledTimes(2);
  });

  it('ignores scene clicks while the picker is open', async () => {
    const { studio, deps } = await opened();
    let grant: (s: MediaStream) => void = () => {};
    deps.openDisplay.mockImplementationOnce(() => new Promise<MediaStream>((r) => (grant = r)));
    const choosing = studio.selectScene('screen');
    await studio.selectScene('pause');
    expect(studio.scene).toBe('camera');
    grant(new FakeMediaStream([]) as unknown as MediaStream);
    await choosing;
    expect(studio.scene).toBe('screen');
  });

  it("the share's sound is heard only in a scene that shows the screen", async () => {
    const { studio, mixer } = await opened();
    expect(mixer.shareAudible).toBe(false);
    await studio.selectScene('screen-camera');
    expect(mixer.shareAudible).toBe(true);
    await studio.selectScene('camera');
    expect(mixer.shareAudible).toBe(false);
    await studio.selectScene('pause');
    expect(mixer.shareAudible).toBe(false);
  });
});

describe('LiveStudio - the share stopped from the browser (owner, 2026-11-14)', () => {
  it('a scene showing the screen becomes PAUSE - never the camera - and says so; the live goes on', async () => {
    const { studio, compositor, mixer, screens } = await opened();
    await studio.selectScene('screen-camera');
    screens[0].video.end();
    expect(studio.scene).toBe('pause');
    expect(compositor.scene).toBe('pause');
    expect(studio.screenEnded).toBe(true);
    expect(studio.screen).toBeNull();
    expect(mixer.share).toBeNull();
    // The next scene clears the notice; a screen scene asks again (a click).
    await studio.selectScene('camera');
    expect(studio.screenEnded).toBe(false);
  });

  it('while another scene is shown, the screen is let go and the scene is kept', async () => {
    const { studio, deps, screens } = await opened();
    await studio.selectScene('screen');
    await studio.selectScene('camera');
    screens[0].video.end();
    expect(studio.scene).toBe('camera');
    expect(studio.screenEnded).toBe(false);
    await studio.selectScene('screen');
    expect(deps.openDisplay).toHaveBeenCalledTimes(2);
  });
});

describe('LiveStudio - the switches and the overlay', () => {
  it('mutes the microphone through the mixer and switches the camera off through the compositor', async () => {
    const { studio, mixer, compositor, mics, cam } = await opened();
    studio.toggleMic();
    expect(mixer.micMuted).toBe(true);
    expect(mics[0].audio.stop).not.toHaveBeenCalled();
    studio.toggleCamera();
    expect(compositor.cameraOn).toBe(false);
    expect(cam.session.phase).toBe('live');
    studio.toggleMic();
    studio.toggleCamera();
    expect(mixer.micMuted).toBe(false);
    expect(compositor.cameraOn).toBe(true);
  });

  it('hands the overlay to the compositor, and nothing when unchanged', async () => {
    const { studio, compositor } = await opened();
    studio.setOverlay({ corner: 'top-left', size: 'large', shape: 'rect' });
    expect(compositor.setOverlay).toHaveBeenLastCalledWith({
      corner: 'top-left',
      size: 'large',
      shape: 'rect',
    });
    compositor.setOverlay.mockClear();
    studio.setOverlay({ corner: 'top-left' });
    expect(compositor.setOverlay).not.toHaveBeenCalled();
  });
});

describe('LiveStudio - release', () => {
  it('gives back the microphone, the screen, the drawing and the sound, once', async () => {
    const { studio, compositor, mixer, mics, screens } = await opened();
    await studio.selectScene('screen');
    studio.release();
    studio.release();
    expect(mics[0].audio.stop).toHaveBeenCalled();
    expect(screens[0].video.stop).toHaveBeenCalled();
    expect(compositor.stop).toHaveBeenCalledTimes(1);
    expect(mixer.close).toHaveBeenCalledTimes(1);
  });

  it('a screen granted after the release is given straight back', async () => {
    const { studio, deps } = await opened();
    let grant: (s: MediaStream) => void = () => {};
    deps.openDisplay.mockImplementationOnce(() => new Promise<MediaStream>((r) => (grant = r)));
    const choosing = studio.selectScene('screen');
    studio.release();
    const late = { stop: vi.fn() };
    grant(new FakeMediaStream([late as never]) as unknown as MediaStream);
    await choosing;
    expect(late.stop).toHaveBeenCalled();
    expect(studio.screen).toBeNull();
  });
});
