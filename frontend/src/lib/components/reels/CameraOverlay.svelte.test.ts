// @vitest-environment happy-dom
/**
 * The camera overlay's HISTORY, against a model of the browser's: `pushState` and `replaceState` are
 * synchronous, and `history.back()` is a TRAVERSAL that lands later and fires `popstate` (Chrome 155,
 * measured 2026-10-14). The overlay owns one entry and a take a second. Nothing here traverses to
 * close: a hand-back or a teardown takes both off the stack at once and leaves their entries as
 * ghosts, which the next overlay takes over or a Back crosses - and the overlay the camera was opened
 * over (the conversation, on a phone) stays open, and is what the next Back closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CameraOverlay from './CameraOverlay.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { screenCover } from '$lib/actions/coversScreen.svelte';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { m } from '$lib/paraglide/messages';
import {
  abandonHistoryOverlay,
  clearHistoryOverlayStack,
  historyOverlayStackDepth,
  initHistoryOverlayStack,
  pushHistoryOverlay,
} from '$lib/utils/historyOverlayStack';
import { flushMacrotask } from '../../../test/flush';

vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(() => Promise.resolve(true)) }));
const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
vi.mock('$app/navigation', async (orig) => ({
  ...(await orig<typeof import('$app/navigation')>()),
  afterNavigate: () => {},
  goto: vi.fn(),
}));
vi.mock('$lib/utils/appVersion', () => ({
  isIosTauriRuntime: () => false,
  isAndroidTauriRuntime: () => false,
  isMobileTauriRuntime: () => false,
}));
vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./VideoPlayerStub.test-helper.svelte')).default,
}));
const framed = vi.hoisted(() => ({ photo: vi.fn(), start: vi.fn(), thumbnail: vi.fn() }));
vi.mock('$lib/reels/framedCapture', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/framedCapture')>()),
  takeFramedPhoto: framed.photo,
  takeFramedThumbnail: framed.thumbnail,
  FramedStream: { start: framed.start },
}));

/** A browser history: entries and a pointer; `back()` lands in a later task, as a traversal does. */
function installHistoryModel() {
  const entries: unknown[] = [null];
  let index = 0;
  let pending = 0;
  vi.spyOn(history, 'state', 'get').mockImplementation(() => entries[index]);
  vi.spyOn(history, 'pushState').mockImplementation((state: unknown) => {
    entries.splice(index + 1, entries.length, state);
    index = entries.length - 1;
  });
  vi.spyOn(history, 'replaceState').mockImplementation((state: unknown) => {
    entries[index] = state;
  });
  vi.spyOn(history, 'back').mockImplementation(() => {
    pending++;
    setTimeout(() => {
      pending--;
      if (index === 0) return;
      index--;
      window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
    }, 0);
  });
  return {
    index: () => index,
    pending: () => pending,
  };
}

function stream(): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => ({}) };
  const s = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  Object.setPrototypeOf(s, MediaStream.prototype);
  return s as unknown as MediaStream;
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

/** Lets every queued traversal land, and whatever it closes settle. */
async function drainTraversals(model: ReturnType<typeof installHistoryModel>) {
  for (let i = 0; i < 10 && model.pending() > 0; i++) {
    await flushMacrotask();
    await settle();
  }
}

/** One left-edge swipe past the threshold, on `from`, committed on `layer`'s slide-out end. */
function edgeSwipe(from: HTMLElement, layer: HTMLElement) {
  for (const [type, clientX] of [
    ['touchstart', 5],
    ['touchmove', 150],
    ['touchend', 150],
  ] as const) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const list = [{ clientX, clientY: 300 }];
    Object.defineProperty(e, 'touches', { value: list });
    Object.defineProperty(e, 'changedTouches', { value: list });
    from.dispatchEvent(e);
  }
  layer.dispatchEvent(new Event('transitionend'));
}

let teardown: () => void = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  framed.photo.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }));
  framed.start.mockReturnValue({ stream: stream(), bitrate: 3_000_000, stop: vi.fn() });
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
  teardown = initHistoryOverlayStack();
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  teardown();
  clearHistoryOverlayStack();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CameraOverlay history', () => {
  it('a chat photo handed back leaves the conversation open, and the next sheet plus one Back closes only that sheet', async () => {
    const model = installHistoryModel();
    const closeConversation = vi.fn();
    // The conversation, opened as an overlay on a phone (useConversations).
    pushHistoryOverlay(closeConversation);
    expect(model.index()).toBe(1);

    const target = document.createElement('div');
    document.body.appendChild(target);
    let open = true;
    const oncapture = vi.fn();
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture,
        onclose: () => {
          open = false;
          unmount(app);
        },
      },
    });
    await settle();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
    video.dispatchEvent(new Event('loadeddata'));
    await settle();

    const shutter = document.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
    shutter.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    shutter.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    // Conversation, camera, take.
    expect(model.index()).toBe(3);

    document.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    await drainTraversals(model);

    expect(oncapture).toHaveBeenCalledTimes(1);
    expect(open).toBe(false);
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    // No traversal: the camera's and the take's entries stay, as ghosts.
    expect(history.back).not.toHaveBeenCalled();
    expect(model.index()).toBe(3);

    // A sheet opens over the conversation: it TAKES the ghost under the pointer.
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeSheet);
    expect(model.index()).toBe(3);
    // One Back closes the sheet, and only the sheet.
    history.back();
    await drainTraversals(model);
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    // The next one closes the conversation - the overlay on screen - and never leaves the app.
    history.back();
    await drainTraversals(model);
    expect(closeConversation).toHaveBeenCalledTimes(1);
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('Back discards a review first, then closes the camera, and never the conversation', async () => {
    const model = installHistoryModel();
    const closeConversation = vi.fn();
    pushHistoryOverlay(closeConversation);

    const target = document.createElement('div');
    document.body.appendChild(target);
    let open = true;
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture: vi.fn(),
        onclose: () => {
          open = false;
          unmount(app);
        },
      },
    });
    await settle();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
    video.dispatchEvent(new Event('loadeddata'));
    await settle();
    const shutter = document.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
    shutter.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    shutter.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    expect(document.querySelector('[data-reel-review]')).not.toBeNull();

    // Back #1: the review is discarded (the confirm answers yes), the camera stays.
    history.back();
    await drainTraversals(model);
    expect(document.querySelector('[data-reel-review]')).toBeNull();
    expect(open).toBe(true);
    expect(model.index()).toBe(2);

    // Back #2: the camera closes.
    history.back();
    await drainTraversals(model);
    expect(open).toBe(false);
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    expect(model.index()).toBe(1);
  });

  it('opened from a menu that gave its entry back in the same tap, Back on a photo ASKS with the photo on screen, and "keep" keeps it (Mi 9T, v1.2.9-alpha.1)', async () => {
    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    const model = installHistoryModel();
    const closeConversation = vi.fn();
    pushHistoryOverlay(closeConversation);
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeMenu);

    // "Ouvrir la camera": the "+" menu abandons its entry and the camera mounts, in ONE task.
    abandonHistoryOverlay(closeMenu);
    const target = document.createElement('div');
    document.body.appendChild(target);
    let open = true;
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture: vi.fn(),
        onclose: () => {
          open = false;
          unmount(app);
        },
      },
    });
    await settle();
    // The camera took the menu's entry over (a hand-off), so nothing traverses.
    expect(history.back).not.toHaveBeenCalled();
    expect(model.index()).toBe(2);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
    video.dispatchEvent(new Event('loadeddata'));
    await settle();
    const shutter = document.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
    shutter.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    shutter.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    // Conversation, camera, take.
    expect(model.index()).toBe(3);

    history.back();
    await drainTraversals(model);

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(open).toBe(true);
    expect(document.querySelector('[data-reel-review]')).not.toBeNull();
    // Kept: Back is armed on the take again, above the camera.
    expect(model.index()).toBe(3);
    expect(closeConversation).not.toHaveBeenCalled();
    unmount(app);
    await drainTraversals(model);
  });

  it('the left-edge swipe over a review is a Back: it ASKS, discards the take, and a second one closes the camera (iPhone 12, v1.2.9-alpha.2)', async () => {
    // A phone layout: the swipe is the iOS app's only Back.
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    );
    installHistoryModel();
    const closeConversation = vi.fn();
    pushHistoryOverlay(closeConversation);
    const target = document.createElement('div');
    document.body.appendChild(target);
    let open = true;
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture: vi.fn(),
        onclose: () => {
          open = false;
          unmount(app);
        },
      },
    });
    await settle();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
    video.dispatchEvent(new Event('loadeddata'));
    await settle();
    const shutter = document.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
    shutter.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    shutter.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    const layer = document.querySelector<HTMLElement>('[role="dialog"]')!;

    edgeSwipe(document.querySelector<HTMLElement>('[data-reel-review]')!, layer);
    await settle();
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-reel-review]')).toBeNull();
    expect(open).toBe(true);

    edgeSwipe(layer, layer);
    await settle();
    expect(open).toBe(false);
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
  });

  it('a chat camera refused does not ask the member to allow the microphone it never asked for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = installHistoryModel();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.reject(new CameraAccessError('denied', 'd'))),
        oncapture: vi.fn(),
        onclose: vi.fn(),
      },
    });
    await settle();
    const alert = document.querySelector('[role="alert"]')!.textContent;
    expect(alert).toContain(m.reels_camera_denied_body_camera_only());
    expect(alert).not.toContain(m.reels_camera_denied_body());
    unmount(app);
    await drainTraversals(model);
  });

  it('takes the focus from the composer field, so no soft keyboard stays over the shutter', async () => {
    const model = installHistoryModel();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture: vi.fn(),
        onclose: vi.fn(),
      },
    });
    await settle();

    expect(document.activeElement).not.toBe(field);
    // The page under the layer is not re-laid out (its scroller would lose its position).
    expect(document.documentElement.classList.contains('fullscreen-place-open')).toBe(false);
    unmount(app);
    await drainTraversals(model);
  });

  it('covers the screen while open, so the native iOS chrome hides over the viewfinder', async () => {
    const model = installHistoryModel();
    const target = document.createElement('div');
    document.body.appendChild(target);
    expect(screenCover.covered).toBe(false);
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(stream())),
        oncapture: vi.fn(),
        onclose: vi.fn(),
      },
    });
    await settle();
    expect(screenCover.covered).toBe(true);
    unmount(app);
    await drainTraversals(model);
    expect(screenCover.covered).toBe(false);
  });

  it('torn down by its owner under a review, it leaves BOTH its entries as ghosts and releases the camera', async () => {
    const model = installHistoryModel();
    const closeConversation = vi.fn();
    pushHistoryOverlay(closeConversation);

    const target = document.createElement('div');
    document.body.appendChild(target);
    const lens = stream();
    const app = mount(CameraOverlay, {
      target,
      props: {
        destination: 'chat',
        session: new CameraSession(() => Promise.resolve(lens)),
        oncapture: vi.fn(),
        onclose: vi.fn(),
      },
    });
    await settle();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
    video.dispatchEvent(new Event('loadeddata'));
    await settle();
    const shutter = document.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
    shutter.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    shutter.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    expect(document.querySelector('[data-reel-review]')).not.toBeNull();
    expect(model.index()).toBe(3);

    // The composer goes away (its conversation was closed by state) with the review still open.
    unmount(app);
    await drainTraversals(model);

    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    expect(history.back).not.toHaveBeenCalled();
    expect(model.index()).toBe(3);
    expect(lens.getTracks()[0].stop).toHaveBeenCalled();
    // The Back that follows closes the conversation, the one overlay still on screen.
    history.back();
    await drainTraversals(model);
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });
});
