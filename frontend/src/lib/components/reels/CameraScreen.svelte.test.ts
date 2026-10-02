/**
 * The camera tab draws one clear state per outcome of the first open (CanaReels, C5): opening, each of
 * the three refusals with its own sentence and a retry, and the live preview with its lens controls.
 * The session's opener is injected, so the order of events is the test's, never a clock's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CameraScreen from './CameraScreen.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { CameraAccessError, type CameraFacing, type CameraFault } from '$lib/reels/cameraAccess';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { m } from '$lib/paraglide/messages';

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
let nativeApp = false;
const openAppSettings = vi.fn(async () => {});
vi.mock('$lib/reels/gallery', () => ({
  hasNativeGallery: () => nativeApp,
  openAppSettings: () => openAppSettings(),
}));

const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  nativeApp = false;
  vi.restoreAllMocks();
  openAppSettings.mockClear();
});

/**
 * A stream the element accepts (`srcObject` checks for a `MediaStream`), its lens' torch decided by
 * the test.
 */
function stream(torch: boolean): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => (torch ? { torch: true } : {}) };
  const s = { getTracks: () => [track], getVideoTracks: () => [track] };
  Object.setPrototypeOf(s, MediaStream.prototype);
  return s as unknown as MediaStream;
}

async function render(open: (facing: CameraFacing) => Promise<MediaStream>) {
  const session = new CameraSession(open);
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(CameraScreen, { target, props: { session } }));
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  return { target, session };
}

describe('CameraScreen', () => {
  it('says the camera is opening while the request is out', async () => {
    const { target } = await render(() => new Promise(() => {}));
    expect(target.querySelector('[data-camera-phase="starting"]')).not.toBeNull();
    expect(target.textContent).toContain(m.reels_camera_starting());
  });

  it.each<[CameraFault, () => string]>([
    ['denied', m.reels_camera_denied_title],
    ['unavailable', m.reels_camera_unavailable_title],
    ['busy', m.reels_camera_busy_title],
  ])('draws its own state for %s, with a retry that asks again', async (fault, title) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.fn().mockRejectedValue(new CameraAccessError(fault, fault));
    const { target } = await render(open);
    expect(target.querySelector(`[data-camera-fault="${fault}"]`)).not.toBeNull();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(title());

    const retry = [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(m.reels_camera_retry())
    );
    retry!.click();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('a refusal on the phone apps offers their settings page, and only a refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    nativeApp = true;
    const denied = await render(() => Promise.reject(new CameraAccessError('denied', 'denied')));
    denied.target.querySelector<HTMLButtonElement>('[data-camera-open-settings]')!.click();
    expect(openAppSettings).toHaveBeenCalled();

    const busy = await render(() => Promise.reject(new CameraAccessError('busy', 'busy')));
    expect(busy.target.querySelector('[data-camera-open-settings]')).toBeNull();
  });

  it('the web has no settings page to offer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { target } = await render(() =>
      Promise.reject(new CameraAccessError('denied', 'denied'))
    );
    expect(target.querySelector('[data-camera-open-settings]')).toBeNull();
  });

  it('offers the torch only on a lens that has one', async () => {
    const lit = await render(() => Promise.resolve(stream(true)));
    expect(lit.target.querySelector(`[aria-label="${m.reels_camera_torch_on()}"]`)).not.toBeNull();
    expect(lit.target.querySelector(`[aria-label="${m.reels_camera_switch()}"]`)).not.toBeNull();

    const dark = await render(() => Promise.resolve(stream(false)));
    expect(dark.target.querySelector(`[aria-label="${m.reels_camera_torch_on()}"]`)).toBeNull();
  });

  describe('between the track and the first frame', () => {
    const preview = (t: HTMLElement) => t.querySelector('video')!;
    const standIn = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-camera-standin]')!;

    it('keeps the engine placeholder out of sight: transparent poster, preview hidden, stand-in up', async () => {
      const { target, session } = await render(() => Promise.resolve(stream(false)));
      // A track is in hand (live) but the element has decoded nothing yet.
      expect(session.phase).toBe('live');
      expect(preview(target).getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
      expect(preview(target).className).toContain('opacity-0');
      expect(standIn(target).dataset.cameraStandin).toBe('shown');
    });

    it('cross-fades to the preview on the first real frame, and not on an empty one', async () => {
      const { target } = await render(() => Promise.resolve(stream(false)));
      const video = preview(target);
      Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true });
      video.dispatchEvent(new Event('loadeddata'));
      flushSync();
      expect(video.className).toContain('opacity-0');

      Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
      video.dispatchEvent(new Event('playing'));
      flushSync();
      expect(video.className).toContain('opacity-100');
      expect(standIn(target).dataset.cameraStandin).toBe('gone');
    });

    it('a refusal replaces the stand-in with its own state', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { target } = await render(() => Promise.reject(new CameraAccessError('busy', 'busy')));
      expect(standIn(target).dataset.cameraStandin).toBe('gone');
      expect(preview(target).className).toContain('opacity-0');
    });
  });

  it('opens on the front lens, mirrors only the preview, and the torch follows the lens', async () => {
    const lensOf: Record<string, MediaStream> = {
      user: stream(false), // the front lens has no torch
      environment: stream(true),
    };
    const open = vi.fn((facing: CameraFacing) => Promise.resolve(lensOf[facing]));
    const { target, session } = await render(open);
    const torch = () => target.querySelector(`[aria-label="${m.reels_camera_torch_on()}"]`);
    const flip = () =>
      target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_camera_switch()}"]`)!;

    expect(open).toHaveBeenCalledWith('user');
    expect(session.facing).toBe('user');
    expect(target.querySelector('video')!.className).toContain('-scale-x-100');
    expect(torch()).toBeNull();

    flip().click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(open).toHaveBeenLastCalledWith('environment');
    expect(target.querySelector('video')!.className).not.toContain('-scale-x-100');
    expect(torch()).not.toBeNull();

    flip().click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(torch()).toBeNull();
  });

  it('gives the camera back when the app goes to the background', async () => {
    const s = stream(false);
    const { session } = await render(() => Promise.resolve(s));
    expect(session.phase).toBe('live');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(session.phase).toBe('stopped');
    expect(s.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('keeps the live preview muted as a property, or the microphone echoes through the speaker', async () => {
    const { target } = await render(() => Promise.resolve(stream(false)));
    const video = target.querySelector('video')!;
    expect(video.muted).toBe(true);
  });
});
