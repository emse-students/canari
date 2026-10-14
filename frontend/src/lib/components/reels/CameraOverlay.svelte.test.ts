/**
 * The camera overlay's HISTORY, against a model of the browser's: `pushState` is synchronous, and
 * `history.back()` is a TRAVERSAL that lands later and fires `popstate` - two calls go back two
 * entries (Chrome 155, measured 2026-10-14). The overlay owns one entry and a take a second; when a
 * composer's take is handed back, BOTH must leave the history and the stack, and the overlay the
 * camera was opened over (the conversation, on a phone) must stay open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CameraOverlay from './CameraOverlay.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import {
  clearHistoryOverlayStack,
  historyOverlayStackDepth,
  initHistoryOverlayStack,
  pushHistoryOverlay,
} from '$lib/utils/historyOverlayStack';

vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(() => Promise.resolve(true)) }));
const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
vi.mock('$lib/utils/appVersion', () => ({
  isIosTauriRuntime: () => false,
  isMobileTauriRuntime: () => false,
}));
vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./VideoPlayerStub.test-helper.svelte')).default,
}));
const framed = vi.hoisted(() => ({ photo: vi.fn(), start: vi.fn() }));
vi.mock('$lib/reels/framedCapture', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/framedCapture')>()),
  takeFramedPhoto: framed.photo,
  FramedStream: { start: framed.start },
}));

/** A browser history: entries and a pointer; `back()` lands in a later task, as a traversal does. */
function installHistoryModel() {
  const entries: unknown[] = [null];
  let index = 0;
  let pending = 0;
  vi.spyOn(history, 'pushState').mockImplementation((state: unknown) => {
    entries.splice(index + 1, entries.length, state);
    index = entries.length - 1;
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
    await new Promise((r) => setTimeout(r, 0));
    await settle();
  }
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
  it('a chat photo handed back leaves the conversation open and the history where it was', async () => {
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
    expect(model.index()).toBe(1);
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
});
