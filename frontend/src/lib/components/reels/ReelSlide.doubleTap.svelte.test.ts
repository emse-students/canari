// @vitest-environment happy-dom
/**
 * A DOUBLE TAP ON A REEL LIKES IT (user, 2026-10-19), and the reel's SINGLE tap is still the
 * player's: it toggles the controls at once, with no wait - the double tap's two taps toggle them
 * there and back, so the like leaves them as they were. Driven against the real `VideoPlayer`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelSlide from './ReelSlide.svelte';
import type { PostEntity } from '$lib/posts/api';

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
});

const reel: PostEntity = {
  id: 'reel1',
  kind: 'reel',
  markdown: '',
  mentions: [],
  links: [],
  media: [{ mediaId: 'm1', type: 'video', mimeType: 'video/mp4' }],
  images: [],
  reactions: {},
  createdAt: '2026-10-15T08:00:00.000Z',
  publishedAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
} as unknown as PostEntity;

function mountSlide(props: { active?: boolean; onLike?: () => boolean }) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(ReelSlide, {
    target,
    props: { post: reel, authToken: 't', active: props.active ?? true, preload: false, ...props },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  const video = target.querySelector('video');
  if (video) {
    // The reel is playing, as the viewer's player is once its first frame is in.
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    video.dispatchEvent(new Event('play'));
    flushSync();
  }
  const bar = target.querySelector('[data-video-controls]') as HTMLElement;
  return { target, video: video!, bar };
}

function tapOn(el: Element, detail: number) {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 80, clientY: 200, detail })
  );
  flushSync();
}

const hearts = (target: HTMLElement) => target.querySelectorAll('[data-double-tap-heart]').length;

it("a single tap is still the player's, at once: the controls go and come back", () => {
  const onLike = vi.fn(() => true);
  const { video, bar } = mountSlide({ onLike });
  expect(bar.className).toContain('opacity-100');

  tapOn(video, 1);
  expect(bar.className).toContain('opacity-0');

  expect(onLike).not.toHaveBeenCalled();
});

it('a double tap likes once, draws the heart, and leaves the controls as they were', () => {
  const onLike = vi.fn(() => true);
  const { target, video, bar } = mountSlide({ onLike });

  tapOn(video, 1);
  tapOn(video, 2);

  expect(onLike).toHaveBeenCalledTimes(1);
  expect(hearts(target)).toBe(1);
  expect(bar.className).toContain('opacity-100');
});

it('a like the viewer refused draws no heart', () => {
  const { target, video } = mountSlide({ onLike: () => false });
  tapOn(video, 1);
  tapOn(video, 2);
  expect(hearts(target)).toBe(0);
});

it("a double tap on the player's bar is the bar's", () => {
  const onLike = vi.fn(() => true);
  const { bar } = mountSlide({ onLike });
  const playPause = bar.querySelector('button')!;
  tapOn(playPause, 1);
  tapOn(playPause, 2);
  expect(onLike).not.toHaveBeenCalled();
});

it('a reel from a conversation (no like) and a reel off screen take no double tap', () => {
  const off = mountSlide({ active: false, onLike: vi.fn(() => true) });
  expect(off.target.querySelector('video')).toBeNull();
  tapOn(off.target.querySelector('[data-reel-slide]')!, 1);
  tapOn(off.target.querySelector('[data-reel-slide]')!, 2);
  expect(hearts(off.target)).toBe(0);

  const chat = mountSlide({});
  tapOn(chat.video, 1);
  tapOn(chat.video, 2);
  expect(hearts(chat.target)).toBe(0);
});
