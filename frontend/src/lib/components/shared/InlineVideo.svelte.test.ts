/**
 * A VIDEO PLAYS WHERE IT IS, AND ONE ANSWER SAYS WHETHER EVERY VIDEO MAKES SOUND (user, 2026-09-29).
 *
 * Pinned: a video starts muted; its sound button changes the answer for EVERY video, the viewer's
 * included, and a change made in the viewer's own controls comes back to the feed; a video plays
 * while it is on screen and pauses when it leaves; a tap outside the sound button opens the viewer.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import InlineVideo from './InlineVideo.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { followVideoSound } from '$lib/actions/playWhileVisible';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';

const mounted: (() => void)[] = [];
let observed: ((entries: { isIntersecting: boolean }[]) => void)[] = [];

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observed.push(cb);
      }
      observe() {}
      disconnect() {}
    }
  );
  videoSound.setMuted(true);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountVideo() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onOpen = vi.fn();
  const component = mount(InlineVideo, {
    target,
    props: { src: 'blob:clip', onOpen, openLabel: 'Plein ecran' },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const video = target.querySelector('video')!;
  const [openButton, soundButton] = Array.from(target.querySelectorAll('button'));
  return { video, openButton, soundButton, onOpen };
}

it('starts muted, and its sound button answers for every video', () => {
  const first = mountVideo();
  const second = mountVideo();
  expect(first.video.muted).toBe(true);
  // Without it the Android WebView draws its own grey play button until the first frame.
  expect(first.video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);

  first.soundButton.click();
  flushSync();

  expect(videoSound.muted).toBe(false);
  expect(second.video.muted).toBe(false);
  expect(first.soundButton.getAttribute('aria-pressed')).toBe('true');
});

it('plays while it is on screen and pauses when it leaves', () => {
  const { video } = mountVideo();
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });

  observed.at(-1)!([{ isIntersecting: true }]);
  observed.at(-1)!([{ isIntersecting: false }]);

  expect(play).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
});

it('opens the viewer on a tap outside the sound button, and not on it', () => {
  const { openButton, soundButton, onOpen } = mountVideo();
  soundButton.click();
  expect(onOpen).not.toHaveBeenCalled();
  openButton.click();
  expect(onOpen).toHaveBeenCalledOnce();
});

it("makes the viewer's own controls give the answer for every video", () => {
  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(viewer.muted).toBe(true);

  viewer.muted = false;
  viewer.dispatchEvent(new Event('volumechange'));

  expect(videoSound.muted).toBe(false);
  action.destroy();
});

it('pauses the video behind the viewer while it is open, and resumes it on close', () => {
  const { video } = mountVideo();
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  observed.at(-1)!([{ isIntersecting: true }]);
  paused = false;
  video.dispatchEvent(new Event('play'));

  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(pause).toHaveBeenCalledOnce();

  paused = true;
  action.destroy();
  expect(play).toHaveBeenCalledTimes(2);
});
