// @vitest-environment happy-dom
/**
 * The camera keeps its layout (owner, 2026-11-11, replacing the turning camera of 2026-11-09;
 * screen-orientation.md): portrait while mounted, no rotate button, a take frozen as it is on screen,
 * the glyphs turned in place by the phone's angle, and the volume-key flag armed only while the
 * preview is live. Run as the Android app, whose bridges record what native is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { stubCameraCount } from '../../../test/cameraDevices';
import { giveMediaStreamGetTracks } from '$lib/reels/mediaStreamTracks.test-helper';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import {
  resetScreenOrientationForTest,
  viewportOrientation,
} from '$lib/mobile/screenOrientation.svelte';
import {
  CAMERA_KEY_EVENT,
  DEVICE_ANGLE_EVENT,
  resetCameraHardwareForTest,
} from '$lib/mobile/cameraHardware.svelte';
import CameraScreen from './CameraScreen.svelte';

giveMediaStreamGetTracks();

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
vi.mock('$lib/reels/gallery', () => ({ hasNativeGallery: () => true, openAppSettings: vi.fn() }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => true,
  isIosTauriRuntime: () => false,
}));

type Win = Window & {
  canariOrientation?: { set: (m: string) => void };
  canariCamera?: { set: (s: string) => void };
};

function liveStream(): MediaStream {
  const lens = {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
    getCapabilities: () => ({}),
    addEventListener: vi.fn(),
  };
  return new MediaStream([lens] as unknown as MediaStreamTrack[]);
}

let sent: string[];
let camera: string[];
let unstubCameras = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  resetScreenOrientationForTest();
  resetCameraHardwareForTest();
  sent = [];
  camera = [];
  (window as Win).canariOrientation = { set: (mode) => sent.push(mode) };
  (window as Win).canariCamera = { set: (state) => camera.push(state) };
  unstubCameras = stubCameraCount(2);
  for (const level of ['debug', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  unstubCameras();
  delete (window as Win).canariOrientation;
  delete (window as Win).canariCamera;
  resetCameraHardwareForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountCamera(props: {
  recording: boolean;
  paused?: boolean;
  onvolumekey?: (phase: string) => void;
}) {
  const session = new CameraSession(() => Promise.resolve(liveStream()));
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CameraScreen, {
    target,
    props: {
      session,
      get recording() {
        return props.recording;
      },
      get paused() {
        return props.paused ?? false;
      },
      get onvolumekey() {
        return props.onvolumekey;
      },
    },
  });
  mounted.push(app);
  flushSync();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flushSync();
  return { app, target };
}

describe('CameraScreen - the camera keeps its layout (owner, 2026-11-11)', () => {
  it('holds portrait while mounted, draws no rotate button, and releases at unmount', async () => {
    const { app, target } = await mountCamera({ recording: false });
    expect(sent).toEqual(['portrait']);
    expect(target.querySelector('[data-rotate-button]')).toBeNull();
    mounted.pop();
    unmount(app);
    expect(sent).toEqual(['portrait']);
  });

  it('a take locks the orientation on screen, and the end of the take frees it', async () => {
    const props = $state({ recording: false });
    await mountCamera(props);
    props.recording = true;
    flushSync();
    expect(sent.at(-1)).toBe('locked');
    props.recording = false;
    flushSync();
    expect(sent.at(-1)).toBe('portrait');
  });

  it('the glyphs turn in place with the phone, the short way', async () => {
    const { target } = await mountCamera({ recording: false });
    const section = target.querySelector<HTMLElement>('section')!;
    expect(section.dataset.cameraGlyphRotation).toBe('0');
    window.dispatchEvent(new CustomEvent(DEVICE_ANGLE_EVENT, { detail: { degrees: 88 } }));
    flushSync();
    // Phone turned clockwise: the glyphs turn a quarter counter-clockwise to read upright.
    expect(section.dataset.cameraGlyphRotation).toBe('-90');
    expect(section.style.getPropertyValue('--camera-glyph-rotation')).toBe('-90deg');
    window.dispatchEvent(new CustomEvent(DEVICE_ANGLE_EVENT, { detail: { degrees: 2 } }));
    flushSync();
    expect(section.dataset.cameraGlyphRotation).toBe('0');
    // Every round control carries the turn.
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.ui-icon-button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.className).toContain('camera-glyph-turn');
  });

  it('arms the volume keys while the preview is live, hands them to the shutter, and drops them when paused', async () => {
    const keys: string[] = [];
    const props = $state({
      recording: false,
      paused: false,
      onvolumekey: (phase: string) => keys.push(phase),
    });
    await mountCamera(props);
    expect(camera).toEqual(['on']);
    window.dispatchEvent(new CustomEvent(CAMERA_KEY_EVENT, { detail: { phase: 'down' } }));
    window.dispatchEvent(new CustomEvent(CAMERA_KEY_EVENT, { detail: { phase: 'up' } }));
    expect(keys).toEqual(['down', 'up']);
    props.paused = true;
    flushSync();
    expect(camera).toEqual(['on', 'off']);
  });

  it('drops the volume keys at unmount, deterministically', async () => {
    const { app } = await mountCamera({ recording: false });
    expect(camera).toEqual(['on']);
    mounted.pop();
    unmount(app);
    expect(camera).toEqual(['on', 'off']);
  });

  it('every round control of the camera is the same CameraControlButton', async () => {
    viewportOrientation.landscape = false;
    const { target } = await mountCamera({ recording: false });
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.ui-icon-button')];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      expect(button.className).toBe(buttons[0].className);
      expect(button.className).toContain('bg-black/30');
    }
  });
});
