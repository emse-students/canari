/**
 * CANARI'S PLAYER REPLACES THE ENGINE'S `controls` IN EVERY VIEWER (user, 2026-10-01).
 *
 * Pinned: no native controls and no native poster ever; the Canari poster covers the box until the
 * first frame is in the element; the controls fade after 2.5 s of playback and come back on a tap;
 * the keyboard plays, pauses and mutes; and a stream's URL reaches the element untouched.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { CONTROLS_FADE_MS } from '$lib/utils/videoPlayback';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

beforeEach(() => {
  videoSound.setMuted(true);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountPlayer(src = 'blob:clip') {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, { target, props: { src } });
  mounted.push(() => unmount(component));
  flushSync();
  const root = target.querySelector('[role="group"]') as HTMLElement;
  const video = target.querySelector('video')!;
  const bar = target.querySelector('[data-video-controls]') as HTMLElement;
  return { target, root, video, bar };
}

/** Makes the element report it is playing, as the engine would before firing `play`. */
function startPlaying(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  video.dispatchEvent(new Event('play'));
  flushSync();
}

it('draws no native controls and no native poster, and its own poster until the first frame', () => {
  const { target, video } = mountPlayer();
  expect(video.hasAttribute('controls')).toBe(false);
  expect(video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).not.toBeNull();

  video.dispatchEvent(new Event('loadeddata'));
  flushSync();

  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).toBeNull();
});

it('hands a stream its URL exactly as minted', () => {
  const { video } = mountPlayer('blob:stream');
  expect(video.getAttribute('src')).toBe('blob:stream');
});

it('fades the controls after 2.5 s of playback, and a tap brings them back', () => {
  vi.useFakeTimers();
  const { video, bar } = mountPlayer();
  startPlaying(video);
  expect(bar.className).toContain('opacity-100');

  vi.advanceTimersByTime(CONTROLS_FADE_MS - 1);
  flushSync();
  expect(bar.className).toContain('opacity-100');
  vi.advanceTimersByTime(1);
  flushSync();
  expect(bar.className).toContain('opacity-0');

  video.click();
  flushSync();
  expect(bar.className).toContain('opacity-100');
});

it('keeps the controls while paused', () => {
  vi.useFakeTimers();
  const { bar } = mountPlayer();
  vi.advanceTimersByTime(CONTROLS_FADE_MS * 3);
  flushSync();
  expect(bar.className).toContain('opacity-100');
});

it('plays from the keyboard and from its play button', () => {
  const { root } = mountPlayer();
  root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

  const playButton = Array.from(root.querySelectorAll('button')).find(
    (b) =>
      b.getAttribute('aria-label') === m.video_play_label() && b.closest('[data-video-controls]')
  )!;
  playButton.click();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

it('its sound button changes the element, which the app-wide answer follows', () => {
  const { root, video } = mountPlayer();
  expect(video.muted).toBe(true);
  const sound = Array.from(root.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === m.video_sound_label()
  )!;
  sound.click();
  video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(video.muted).toBe(false);
  expect(videoSound.muted).toBe(false);
  expect(sound.getAttribute('aria-pressed')).toBe('true');
});

it('says when the engine refuses the video, instead of a black box', () => {
  const { target, video } = mountPlayer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  video.dispatchEvent(new Event('error'));
  flushSync();
  expect(target.textContent).toContain(m.video_unplayable());
});
