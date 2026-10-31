// @vitest-environment happy-dom
/**
 * The camera tab draws one clear state per outcome of the first open (CanaReels, C5): opening, each of
 * the three refusals with its own sentence and a retry, and the live preview with its lens controls.
 * The session's opener is injected, so the order of events is the test's, never a clock's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubCameraCount } from '../../../test/cameraDevices';
import { flushSync, mount, unmount } from 'svelte';
import CameraScreen from './CameraScreen.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { CameraAccessError, type CameraFacing, type CameraFault } from '$lib/reels/cameraAccess';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { m } from '$lib/paraglide/messages';
import { giveMediaStreamGetTracks } from '$lib/reels/mediaStreamTracks.test-helper';

giveMediaStreamGetTracks();

const nav = vi.hoisted(() => ({
  goto: vi.fn(),
  arrive: null as null | ((n: { from: { url: URL } | null }) => void),
}));
vi.mock('$app/navigation', () => ({
  afterNavigate: (cb: (n: { from: { url: URL } | null }) => void) => {
    nav.arrive = cb;
  },
  goto: nav.goto,
}));
let nativeApp = false;
const openAppSettings = vi.fn(async () => {});
vi.mock('$lib/reels/gallery', () => ({
  hasNativeGallery: () => nativeApp,
  openAppSettings: () => openAppSettings(),
}));

const mounted: Record<string, unknown>[] = [];

let unstubCameras = () => {};
beforeEach(() => {
  unstubCameras = stubCameraCount(2);
});

afterEach(() => {
  unstubCameras();
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
  const s = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
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

describe('CameraScreen close', () => {
  it('goes back to the tab it was opened from, replacing its own entry', async () => {
    const { target } = await render(() => new Promise(() => {}));
    nav.arrive?.({ from: { url: new URL('https://x.test/dashboard') } });
    nav.goto.mockClear();

    (target.querySelector(`[aria-label="${m.reels_camera_close()}"]`) as HTMLElement).click();

    expect(nav.goto).toHaveBeenCalledWith(expect.stringContaining('/dashboard'), {
      replace: true,
    });
  });

  it('goes to the feed when the camera was the first page', async () => {
    const { target } = await render(() => new Promise(() => {}));
    nav.arrive?.({ from: null });
    nav.goto.mockClear();

    (target.querySelector(`[aria-label="${m.reels_camera_close()}"]`) as HTMLElement).click();

    expect(nav.goto).toHaveBeenCalledWith(expect.stringContaining('/posts'), {
      replace: true,
    });
  });
});

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

  it('a camera that never asked for the microphone does not name it in its refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new CameraSession(() => Promise.reject(new CameraAccessError('denied', 'd')));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(CameraScreen, { target, props: { session, microphoneAsked: false } }));
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    const alert = target.querySelector('[role="alert"]')!.textContent;
    expect(alert).toContain(m.reels_camera_denied_body_camera_only());
    expect(alert).not.toContain(m.reels_camera_denied_body());

    // The reel tab asks both in one request: its refusal names both.
    const reel = await render(() => Promise.reject(new CameraAccessError('denied', 'd')));
    expect(reel.target.querySelector('[role="alert"]')!.textContent).toContain(
      m.reels_camera_denied_body()
    );
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

  it('offers no switch on a device with one camera (owner, 2026-10-31)', async () => {
    unstubCameras();
    unstubCameras = stubCameraCount(1);
    const one = await render(() => Promise.resolve(stream(false)));
    await vi.waitFor(() => expect(one.session.cameraCount).toBe(1));
    flushSync();
    expect(one.target.querySelector(`[aria-label="${m.reels_camera_switch()}"]`)).toBeNull();
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

    expect(open).toHaveBeenCalledWith('user', false);
    expect(session.facing).toBe('user');
    expect(target.querySelector('video')!.className).toContain('-scale-x-100');
    expect(torch()).toBeNull();

    flip().click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(open).toHaveBeenLastCalledWith('environment', true);
    expect(target.querySelector('video')!.className).not.toContain('-scale-x-100');
    expect(torch()).not.toBeNull();

    flip().click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(torch()).toBeNull();
  });

  it('hands every stream its OWN video element - a reused one drew a letterboxed preview on iOS', async () => {
    // WKWebView keeps an element's media layer at its first layout size: after a background and
    // return, the same element given a second stream drew ~65 % of the screen while its CSS box was
    // full (iPhone 12, 2026-10-02). Only the element's identity can be pinned off the device.
    const { target, session } = await render(() => Promise.resolve(stream(false)));
    const first = target.querySelector('video')!;
    expect(first.srcObject).toBe(session.stream);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    const second = target.querySelector('video')!;
    expect(session.phase).toBe('live');
    expect(second).not.toBe(first);
    expect(second.srcObject).toBe(session.stream);
  });

  it('asks for the camera ONCE when the permission dialog backgrounds the app, and shows its refusal (Mi 9T, v1.2.9-alpha.1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let refuse: (e: unknown) => void = () => {};
    const open = vi.fn(
      () =>
        new Promise<MediaStream>((_, reject) => {
          refuse = reject;
        })
    );
    const { target } = await render(open);
    // The dialog hides the WebView, the member refuses, the WebView comes back.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    refuse(new CameraAccessError('denied', 'denied'));
    await Promise.resolve();
    await Promise.resolve();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    flushSync();

    expect(open).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-camera-fault="denied"]')).not.toBeNull();
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

describe('CameraScreen - deferOpen (the gallery picker, Mi 9T 2026-10-28)', () => {
  async function renderWith(props: { paused: boolean; deferOpen: boolean; onreopen?: () => void }) {
    const open = vi.fn(() => Promise.resolve(stream(false)));
    const session = new CameraSession(open);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(CameraScreen, { target, props: Object.assign(props, { session }) }));
    const settle = async () => {
      flushSync();
      await Promise.resolve();
      await Promise.resolve();
      flushSync();
    };
    await settle();
    return { target, open, settle };
  }

  it('a pause lifted while the open is deferred opens nothing; the deferral lifted opens it', async () => {
    const props = $state({ paused: true, deferOpen: true });
    const { target, open, settle } = await renderWith(props);
    expect(open).not.toHaveBeenCalled();

    props.paused = false;
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(target.querySelector('[data-camera-phase="stopped"]')).not.toBeNull();

    props.deferOpen = false;
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a deferral nothing ends offers the member a tap that asks for the camera, only on screen', async () => {
    // A picker that never answers (no `cancel` event, a native dismissal never settled) leaves the
    // deferral set: the stand-in must not say "opening" for ever.
    const onreopen = vi.fn();
    const props = $state({ paused: false, deferOpen: true, onreopen });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const { target, open, settle } = await renderWith(props);
    expect(target.querySelector('[data-camera-reopen]')).toBeNull();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    const reopen = target.querySelector<HTMLButtonElement>('[data-camera-reopen]')!;
    expect(reopen.textContent?.trim()).toBe(m.reels_camera_reopen());
    expect(target.textContent).not.toContain(m.reels_camera_starting());
    expect(open).not.toHaveBeenCalled();

    reopen.click();
    expect(onreopen).toHaveBeenCalledTimes(1);
    props.deferOpen = false;
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-camera-reopen]')).toBeNull();
  });

  it('no reopen is offered over a LIVE camera, a pause, or with no owner to lift the deferral', async () => {
    const live = $state({ paused: false, deferOpen: false, onreopen: vi.fn() });
    const first = await renderWith(live);
    live.deferOpen = true;
    await first.settle();
    expect(first.target.querySelector('[data-camera-reopen]')).toBeNull();

    const pausedProps = $state({ paused: true, deferOpen: true, onreopen: vi.fn() });
    const second = await renderWith(pausedProps);
    expect(second.target.querySelector('[data-camera-reopen]')).toBeNull();

    const ownerless = $state({ paused: false, deferOpen: true });
    const third = await renderWith(ownerless);
    expect(third.target.querySelector('[data-camera-reopen]')).toBeNull();
  });

  it('a deferral never closes a LIVE camera (a picker that does not hide the page)', async () => {
    const props = $state({ paused: false, deferOpen: false });
    const { target, open, settle } = await renderWith(props);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();

    props.deferOpen = true;
    await settle();
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('CameraScreen and the theme', () => {
  it("entering and leaving the camera in the iOS app leaves the page's theme where it was", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { themeStore } = await import('$lib/stores/themeStore.svelte');
    // The iOS shell: a posted theme becomes the window's style, which WKWebView's media query follows.
    let schemeDark = false;
    const listeners: Array<(e: { matches: boolean }) => void> = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('dark') ? schemeDark : false,
      media: query,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
      removeEventListener: () => {},
    }));
    const postMessage = vi.fn((theme: string) => {
      if ((theme === 'dark') === schemeDark) return;
      schemeDark = theme === 'dark';
      for (const cb of listeners) cb({ matches: schemeDark });
    });
    vi.stubGlobal('webkit', { messageHandlers: { canariTheme: { postMessage } } });
    localStorage.removeItem('canari-theme');
    try {
      themeStore.init();
      expect(document.documentElement.dataset.theme).toBe('light');

      await render(() => Promise.resolve(stream(false)));
      expect(postMessage).toHaveBeenLastCalledWith('dark');
      expect(document.documentElement.dataset.theme).toBe('light');

      unmount(mounted.pop()!);
      expect(postMessage).toHaveBeenLastCalledWith('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(localStorage.getItem('canari-theme')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CameraScreen - zoom and the double tap (user, 2026-10-22)', () => {
  /** A lens with no zoom capability (WKWebView) and a live microphone, as the reel tab opens it. */
  function lensWithMic() {
    const lens = {
      kind: 'video',
      readyState: 'live',
      stop: vi.fn(),
      getCapabilities: () => ({}),
      addEventListener: vi.fn(),
    };
    const mic = { kind: 'audio', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
    return { lens, mic, stream: new MediaStream([lens, mic] as unknown as MediaStreamTrack[]) };
  }

  async function mountLive(props: Record<string, unknown>, session: CameraSession) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(CameraScreen, { target, props: { session, ...props } }));
    flushSync();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    flushSync();
    return target;
  }

  /** Two quick taps of the finger `pointerId` on the preview. */
  function doubleTap(target: HTMLElement, pointerId = 2) {
    const video = target.querySelector('video')!;
    for (const t of [0, 100]) {
      for (const [type, at] of [
        ['pointerdown', t],
        ['pointerup', t + 40],
      ] as const) {
        const event = new PointerEvent(type, {
          pointerId,
          bubbles: true,
          clientX: 50,
          clientY: 50,
        });
        Object.defineProperty(event, 'timeStamp', { value: 10_000 + at });
        video.dispatchEvent(event);
      }
    }
  }

  it('a DIGITAL zoom enlarges the preview about its centre, and only above 1x', async () => {
    const { stream } = lensWithMic();
    const session = new CameraSession(() => Promise.resolve(stream));
    const target = await mountLive({}, session);
    const video = () => target.querySelector('video')!;
    expect(session.zoomRange.mode).toBe('digital');
    expect(video().style.transform).toBe('');

    session.setZoom(2.5);
    flushSync();
    expect(video().style.transform).toBe('scale(2.5)');
    expect(video().dataset.cameraZoom).toBe('2.50');

    session.resetZoom();
    flushSync();
    expect(video().style.transform).toBe('');
  });

  it('a double tap on the preview flips the lens outside a take', async () => {
    const { stream } = lensWithMic();
    const open = vi.fn((_facing: CameraFacing) => Promise.resolve(stream));
    const session = new CameraSession(open);
    const target = await mountLive({}, session);
    doubleTap(target);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(open).toHaveBeenLastCalledWith('environment', true);
    expect(session.facing).toBe('environment');
  });

  it('a MEASURED single camera stands the double tap down; an unknown count keeps it (fails open)', async () => {
    const one = lensWithMic();
    const openOne = vi.fn((_facing: CameraFacing) => Promise.resolve(one.stream));
    const single = new CameraSession(openOne, openOne, async () => 1);
    const oneTarget = await mountLive({}, single);
    await vi.waitFor(() => expect(single.cameraCount).toBe(1));
    doubleTap(oneTarget);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(openOne).toHaveBeenCalledTimes(1);

    const unknown = lensWithMic();
    const openUnknown = vi.fn((_facing: CameraFacing) => Promise.resolve(unknown.stream));
    const session = new CameraSession(openUnknown, openUnknown, async () => {
      throw new Error('no list');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknownTarget = await mountLive({}, session);
    expect(session.cameraCount).toBeNull();
    doubleTap(unknownTarget, 3);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(openUnknown).toHaveBeenLastCalledWith('environment', true);
  });

  it('DURING A TAKE a double tap flips only the lens: the microphone runs on, the zoom is back at 1x', async () => {
    const first = lensWithMic();
    const back = lensWithMic().lens;
    const openLens = vi.fn((_facing: CameraFacing) =>
      Promise.resolve(new MediaStream([back] as unknown as MediaStreamTrack[]))
    );
    const session = new CameraSession(() => Promise.resolve(first.stream), openLens);
    const target = await mountLive({ recording: true }, session);
    session.setZoom(3);

    doubleTap(target);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    flushSync();

    expect(openLens).toHaveBeenCalledWith('environment', true);
    expect(first.lens.stop).toHaveBeenCalled();
    expect(first.mic.stop).not.toHaveBeenCalled();
    expect(session.stream!.getAudioTracks()).toEqual([first.mic]);
    expect(session.phase).toBe('live');
    expect(session.zoom).toBe(1);
    // The lens button is offered during the take too, and the close button stands down.
    expect(target.querySelector(`[aria-label="${m.reels_camera_switch()}"]`)).not.toBeNull();
    expect(target.querySelector(`[aria-label="${m.reels_camera_close()}"]`)).toBeNull();
  });

  it('a single tap on the preview does nothing', async () => {
    const { stream } = lensWithMic();
    const open = vi.fn((_facing: CameraFacing) => Promise.resolve(stream));
    const session = new CameraSession(open);
    const target = await mountLive({}, session);
    const video = target.querySelector('video')!;
    video.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, bubbles: true }));
    video.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, bubbles: true }));
    // A double tap flips on its second lift, synchronously; nothing waits for a window to close
    // (previewDoubleTap.ts), so the microtasks a flip would run are all there is to wait for.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    expect(session.facing).toBe('user');
  });

  it('while the capture forbids a flip, the double tap and the lens button both stand down', async () => {
    const { stream } = lensWithMic();
    const open = vi.fn((_facing: CameraFacing) => Promise.resolve(stream));
    const openLens = vi.fn((_facing: CameraFacing) => Promise.resolve(stream));
    const session = new CameraSession(open, openLens);
    const target = await mountLive({ recording: true, flipAllowed: false }, session);
    const button = target.querySelector<HTMLButtonElement>(
      `[aria-label="${m.reels_camera_switch()}"]`
    )!;
    expect(button.disabled).toBe(true);

    doubleTap(target);
    button.click();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(open).toHaveBeenCalledTimes(1);
    expect(openLens).not.toHaveBeenCalled();
    expect(session.facing).toBe('user');
  });
});
