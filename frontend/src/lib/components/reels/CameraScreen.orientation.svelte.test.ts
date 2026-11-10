// @vitest-environment happy-dom
/**
 * The camera turns with the phone (owner, 2026-11-09; screen-orientation.md): auto while mounted, the
 * rotate button, a take frozen in the orientation it started in, the frame 16:9 when turned, and
 * portrait again at unmount. Run as the Android app, whose bridge records what native is told.
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
import CameraScreen from './CameraScreen.svelte';

giveMediaStreamGetTracks();

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
vi.mock('$lib/reels/gallery', () => ({ hasNativeGallery: () => true, openAppSettings: vi.fn() }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => true,
  isIosTauriRuntime: () => false,
}));

type Win = Window & { canariOrientation?: { set: (m: string) => void } };

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
let unstubCameras = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  resetScreenOrientationForTest();
  sent = [];
  (window as Win).canariOrientation = { set: (mode) => sent.push(mode) };
  unstubCameras = stubCameraCount(2);
  for (const level of ['debug', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  unstubCameras();
  delete (window as Win).canariOrientation;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountCamera(props: { recording: boolean }) {
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
    },
  });
  mounted.push(app);
  flushSync();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flushSync();
  return { app, target };
}

describe('CameraScreen - the orientation (owner, 2026-11-09)', () => {
  it('asks for auto while mounted and gives portrait back at unmount', async () => {
    const { app } = await mountCamera({ recording: false });
    expect(sent).toEqual(['auto']);
    mounted.pop();
    unmount(app);
    expect(sent).toEqual(['auto', 'portrait']);
  });

  it('the rotate button turns it to landscape, and a second press back to portrait', async () => {
    viewportOrientation.landscape = false;
    const { target } = await mountCamera({ recording: false });
    const button = () => target.querySelector<HTMLButtonElement>('[data-rotate-button]')!;
    expect(button().dataset.rotateButton).toBe('to-landscape');
    button().click();
    expect(sent.at(-1)).toBe('landscape');
    viewportOrientation.landscape = true;
    flushSync();
    expect(button().dataset.rotateButton).toBe('to-portrait');
    button().click();
    expect(sent.at(-1)).toBe('portrait');
  });

  it('a take locks the orientation it started in, and the button stands down', async () => {
    const props = $state({ recording: false });
    viewportOrientation.landscape = false;
    const { target } = await mountCamera(props);
    viewportOrientation.landscape = true;
    props.recording = true;
    flushSync();
    // `locked`: what is on screen and no other side, on a tablet too (screen-orientation.md).
    expect(sent.at(-1)).toBe('locked');
    expect(target.querySelector<HTMLButtonElement>('[data-rotate-button]')!.disabled).toBe(true);
    props.recording = false;
    flushSync();
    expect(sent.at(-1)).toBe('auto');
  });
});
