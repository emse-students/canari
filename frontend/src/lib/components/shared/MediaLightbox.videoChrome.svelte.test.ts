// @vitest-environment happy-dom
/**
 * THE VIEWER'S HEADER LEAVES WITH THE VIDEO'S CONTROLS (owner, 2026-11-09, production 1.6.8: "the
 * header sometimes does not leave" - the back arrow and the time stayed up while the video played).
 *
 * The viewer's bars used to hide only on the viewer's own tap, while the player's glass bar faded on
 * its clock and was unmounted: a playing video left the header up for ever. The bars now follow the
 * controls (`videoViewerChrome`). One test per way the header used to stay, and per way it must come
 * back: a pause, a mouse over it, a key focus on Back, the next video of a gallery, a photo.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Host from './MediaLightboxVideoHost.test-helper.svelte';
import { CONTROLS_FADE_MS } from '$lib/utils/videoPlayback';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

beforeEach(() => {
  videoSound.setMuted(true);
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(slide: 'video-a' | 'video-b' | 'image' = 'video-a') {
  const props = $state({ slide });
  const instance = mount(Host, { target: document.body, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return props;
}

const header = () => document.querySelector<HTMLElement>('[data-viewer-header]')!;
const headerShown = () => !header().classList.contains('opacity-0');
const barShown = () => document.querySelector('[data-video-bar]') !== null;
const video = () => document.querySelector('video')!;

function startPlaying() {
  Object.defineProperty(video(), 'paused', { configurable: true, get: () => false });
  video().dispatchEvent(new Event('play'));
  flushSync();
}

function fade() {
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
}

describe('the header follows the video controls', () => {
  it('shows with the controls, leaves when they fade, and returns on a tap', () => {
    open();
    startPlaying();
    expect(headerShown()).toBe(true);

    fade();
    expect(barShown()).toBe(false);
    expect(headerShown(), 'the header fades with the glass bar').toBe(false);

    video().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    flushSync();
    expect(barShown()).toBe(true);
    expect(headerShown()).toBe(true);
  });

  it('comes back with a pause (an arbiter pausing the video raises its controls)', () => {
    open();
    startPlaying();
    fade();
    expect(headerShown()).toBe(false);

    Object.defineProperty(video(), 'paused', { configurable: true, get: () => true });
    video().dispatchEvent(new Event('pause'));
    flushSync();
    expect(headerShown()).toBe(true);
  });

  it('comes back when a mouse reaches the player', () => {
    open();
    startPlaying();
    fade();
    document
      .querySelector('[data-video-player]')!
      .dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    flushSync();
    expect(headerShown()).toBe(true);
  });

  it('keeps the controls up while a mouse rests on the header itself', () => {
    open();
    startPlaying();
    vi.advanceTimersByTime(CONTROLS_FADE_MS - 100);
    header().dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
    );
    flushSync();
    vi.advanceTimersByTime(CONTROLS_FADE_MS - 100);
    flushSync();
    expect(headerShown(), 'the mouse restarted the fade').toBe(true);
  });

  it('comes back when Back takes the keyboard focus, never a focused control at opacity 0', () => {
    open();
    startPlaying();
    fade();
    expect(headerShown()).toBe(false);

    header()
      .querySelector('button')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    flushSync();
    expect(barShown()).toBe(true);
    expect(headerShown()).toBe(true);
  });

  it('a touch on the header does not raise anything by itself', () => {
    open();
    startPlaying();
    fade();
    header().dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch' })
    );
    flushSync();
    expect(headerShown()).toBe(false);
  });
});

describe('a player that fails', () => {
  it('brings the header back over its message, and does not fade it again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open();
    startPlaying();
    fade();
    expect(headerShown()).toBe(false);

    video().dispatchEvent(new Event('error'));
    flushSync();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(headerShown(), 'a faded header over an error nobody can dismiss').toBe(true);
    fade();
    expect(headerShown(), 'nothing left to fade with').toBe(true);
  });
});

describe('the header is given back when the player leaves', () => {
  it('the next video of a gallery starts with its own controls up', () => {
    const props = open('video-a');
    startPlaying();
    fade();
    expect(headerShown()).toBe(false);

    props.slide = 'video-b';
    flushSync();
    expect(barShown(), 'a new player starts with its bar').toBe(true);
    expect(headerShown()).toBe(true);
  });

  it('a photo after a video never inherits the faded header', () => {
    const props = open('video-a');
    startPlaying();
    fade();
    expect(headerShown()).toBe(false);

    props.slide = 'image';
    flushSync();
    expect(document.querySelector('video')).toBeNull();
    expect(headerShown()).toBe(true);
  });

  it('a photo alone keeps its header: nothing but the viewer s own tap hides it', () => {
    open('image');
    vi.advanceTimersByTime(CONTROLS_FADE_MS * 4);
    flushSync();
    expect(headerShown()).toBe(true);
  });
});
