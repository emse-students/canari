// @vitest-environment happy-dom
/**
 * A SINGLE TAP HIDES OR SHOWS THE REEL'S OVERLAY (owner, 2026-11-18). The slide draws what the viewer
 * says (`overlayHidden`): the caption block and the rail go INVISIBLE and INERT - out of the tab order
 * and of the accessibility tree, taps falling through to the picture - and a tap on the picture asks
 * the viewer to flip it. Driven against the real slide and its real player.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelSlide from './ReelSlide.svelte';
import type { PostEntity } from '$lib/posts/api';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { GESTURE } from '$lib/utils/viewerGestures';
import { HOLD_TO_PAUSE_MS } from '$lib/actions/videoGestures';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaPlayerStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('./AvatarStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
  videoSound.setMuted(true);
});

const reel = {
  id: 'reel1',
  kind: 'reel',
  markdown: 'A caption',
  mentions: [],
  links: [],
  media: [{ mediaId: 'm1', type: 'video', mimeType: 'video/mp4' }],
  images: [],
  reactions: {},
  createdAt: '2026-10-15T08:00:00.000Z',
  publishedAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
} as unknown as PostEntity;

function mountSlide(props: { overlayHidden?: boolean; onLike?: () => boolean }) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const onToggleOverlay = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(ReelSlide, {
    target,
    props: {
      authToken: 't',
      active: true,
      preload: false,
      post: reel,
      onToggleOverlay,
      ...props,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return { target, onToggleOverlay, video: target.querySelector('video')! };
}

function click(el: Element, detail = 1) {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 80, clientY: 200, detail })
  );
  flushSync();
}

const caption = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-reel-caption]')!;
const rail = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-reel-rail]')!.parentElement!;

it('shown, the caption and the rail are visible and reachable', () => {
  const { target } = mountSlide({});
  expect(target.querySelector('[data-reel-slide]')!.getAttribute('data-reel-overlay')).toBe(
    'shown'
  );
  for (const el of [caption(target), rail(target)]) {
    expect(el.hasAttribute('inert')).toBe(false);
    expect(el.className).not.toContain('invisible');
  }
});

it('hidden, the caption, the author row and the rail are invisible AND inert; the player line stays', () => {
  const { target } = mountSlide({ overlayHidden: true });
  expect(target.querySelector('[data-reel-slide]')!.getAttribute('data-reel-overlay')).toBe(
    'hidden'
  );
  for (const el of [caption(target), rail(target)]) {
    expect(el.hasAttribute('inert'), 'not focusable, not announced').toBe(true);
    expect(el.className).toContain('invisible');
  }
  expect(caption(target).querySelector('[data-reel-author]')).not.toBeNull();
  expect(target.querySelector('[data-video-line-slot]')?.closest('[inert]') ?? null).toBeNull();
});

it('a single tap on the picture asks the viewer to flip the overlay - after the like window where likes exist', () => {
  vi.useFakeTimers();
  const onLike = vi.fn(() => true);
  const { video, onToggleOverlay } = mountSlide({ onLike });
  click(video);
  expect(onToggleOverlay).not.toHaveBeenCalled();
  vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
  expect(onToggleOverlay).toHaveBeenCalledTimes(1);
  expect(onLike).not.toHaveBeenCalled();
});

it('a double tap likes and flips nothing', () => {
  vi.useFakeTimers();
  const onLike = vi.fn(() => true);
  const { video, onToggleOverlay } = mountSlide({ onLike });
  click(video, 1);
  click(video, 2);
  vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
  expect(onLike).toHaveBeenCalledTimes(1);
  expect(onToggleOverlay).not.toHaveBeenCalled();
});

it('a single tap never pauses the video, and a press held still does', () => {
  vi.useFakeTimers();
  const { video, onToggleOverlay } = mountSlide({});
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  video.dispatchEvent(new Event('play'));
  flushSync();
  const pause = vi.mocked(HTMLMediaElement.prototype.pause);
  pause.mockClear();
  click(video);
  expect(onToggleOverlay).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();

  video.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
  expect(pause, 'the hold is the one pause').toHaveBeenCalledTimes(1);
  video.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  click(video);
  expect(onToggleOverlay, 'the click ending a hold is no tap').toHaveBeenCalledTimes(1);
});

it('a tap on a control of the overlay (the rail, the caption toggle, the author) never flips it', () => {
  const { target, onToggleOverlay } = mountSlide({});
  for (const el of target.querySelectorAll<HTMLElement>(
    '[data-reel-rail] button:not([data-reel-save]), [data-reel-author], [data-video-controls]'
  )) {
    click(el);
  }
  expect(onToggleOverlay).not.toHaveBeenCalled();
});

it('a keyboard or assistive activation (detail 0) on the picture flips nothing', () => {
  const { video, onToggleOverlay } = mountSlide({});
  click(video, 0);
  expect(onToggleOverlay).not.toHaveBeenCalled();
});
