/**
 * The camera tab draws one clear state per outcome of the first open (CanaReels, C5): opening, each of
 * the three refusals with its own sentence and a retry, and the live preview with its lens controls.
 * The session's opener is injected, so the order of events is the test's, never a clock's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CameraScreen from './CameraScreen.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { CameraAccessError, type CameraFault } from '$lib/reels/cameraAccess';
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

async function render(open: () => Promise<MediaStream>) {
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

  it('gives the camera back when the app goes to the background', async () => {
    const s = stream(false);
    const { session } = await render(() => Promise.resolve(s));
    expect(session.phase).toBe('live');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(session.phase).toBe('stopped');
    expect(s.getTracks()[0].stop).toHaveBeenCalled();
  });
});
