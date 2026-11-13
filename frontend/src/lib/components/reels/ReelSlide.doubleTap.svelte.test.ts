// @vitest-environment happy-dom
/**
 * A DOUBLE TAP ON A REEL LIKES IT (user, 2026-10-19), and the reel's SINGLE tap is still the
 * player's - the sound since the shared player (owner, 2026-11-09). On a surface that likes, the
 * single tap waits for the double-tap window (`videoGestures` reads `data-double-tap-likes`), so a
 * like leaves the sound exactly as it was, never flipped twice. Driven against the real `VideoPlayer`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelSlide from './ReelSlide.svelte';
import type { PostEntity } from '$lib/posts/api';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { GESTURE } from '$lib/utils/viewerGestures';

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

function mountSlide(props: { active?: boolean; onLike?: () => boolean; post?: PostEntity }) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(ReelSlide, {
    target,
    props: {
      authToken: 't',
      active: props.active ?? true,
      preload: false,
      ...props,
      post: props.post ?? reel,
    },
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

it("a single tap is still the player's: the sound ON, once the double-tap window has passed", () => {
  vi.useFakeTimers();
  const onLike = vi.fn(() => true);
  const { video } = mountSlide({ onLike });
  expect(video.muted).toBe(true);

  tapOn(video, 1);
  expect(video.muted, 'a second tap could still make it a like').toBe(true);
  vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
  expect(video.muted).toBe(false);
  expect(onLike).not.toHaveBeenCalled();

  // A tap on a video that has its sound never mutes it (owner, 2026-11-10).
  tapOn(video, 1);
  vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
  expect(video.muted, 'a single tap never turns the sound off').toBe(false);
  expect(onLike).not.toHaveBeenCalled();
});

it('a double tap likes once, draws the heart, and leaves the sound as it was', () => {
  vi.useFakeTimers();
  const onLike = vi.fn(() => true);
  const { target, video } = mountSlide({ onLike });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
  pause.mockClear();
  play.mockClear();

  tapOn(video, 1);
  tapOn(video, 2);
  vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);

  expect(onLike).toHaveBeenCalledTimes(1);
  expect(hearts(target)).toBe(1);
  expect(video.muted).toBe(true);
  // The pair is no single tap: playback is as it was.
  expect(pause).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
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

it("a caption's link is tappable, and a double tap on it is the link's, never a like", () => {
  const onLike = vi.fn(() => true);
  const { target } = mountSlide({
    onLike,
    post: { ...reel, markdown: 'voir https://example.org/page' } as PostEntity,
  });
  const link = target.querySelector<HTMLAnchorElement>(
    '[data-reel-caption] .post-markdown a[href]'
  )!;
  expect(link.getAttribute('href')).toBe('https://example.org/page');
  // The caption is pointer-transparent; its links are not (owner, 2026-11-06).
  expect(link.closest('[data-reel-caption] .post-markdown')!.className).toContain(
    '[&_a]:pointer-events-auto'
  );
  // On the viewer's dark scrim in either app theme: the `dark:` colours of the link, the mention and
  // the hashtag apply (`data-theme="dark"`, the scope of `app.css`'s dark variant).
  expect(link.closest('[data-theme="dark"]')).not.toBeNull();
  link.addEventListener('click', (e) => e.preventDefault());
  tapOn(link, 1);
  tapOn(link, 2);
  expect(onLike).not.toHaveBeenCalled();
  expect(hearts(target)).toBe(0);
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
