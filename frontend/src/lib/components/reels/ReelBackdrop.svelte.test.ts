/**
 * The backdrop paints ONCE per source, on an event, and has no per-frame work: no timer, no animation
 * frame, no second video (Mi 9T, 2026-10-16: a 250 ms re-sample cost ~25 ms a read and holed the
 * camera's take). A video is read on its first presented frame after `playing`; a blank read waits
 * for the next presented frame, a bounded number of times.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BackdropPaintResult } from '$lib/reels/reelBackdropPaint';

const paint = vi.hoisted(() => vi.fn((): BackdropPaintResult => 'painted'));
vi.mock('$lib/reels/reelBackdropPaint', () => ({ paintBlurredBackdrop: paint }));

import ReelBackdrop from './ReelBackdrop.svelte';

beforeEach(() => {
  paint.mockReset();
  paint.mockReturnValue('painted');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A video whose presented frames the test delivers by hand. */
function fakeVideo(src: unknown = 'blob:reel-1') {
  const video = document.createElement('video');
  const callbacks: (() => void)[] = [];
  let source = src;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
  Object.defineProperty(video, 'currentSrc', {
    configurable: true,
    get: () => (typeof source === 'string' ? source : ''),
  });
  Object.defineProperty(video, 'srcObject', {
    configurable: true,
    get: () => (typeof source === 'string' ? null : source),
  });
  Object.assign(video, {
    requestVideoFrameCallback: (cb: () => void) => callbacks.push(cb),
  });
  return {
    video,
    setSource: (next: unknown) => (source = next),
    pendingFrames: () => callbacks.length,
    /** Presents one frame: runs the callbacks registered so far. */
    present: () => callbacks.splice(0).forEach((cb) => cb()),
  };
}

function setup(active: boolean, media: HTMLElement) {
  const host = document.createElement('div');
  host.append(media);
  document.body.append(host);
  const addSpy = vi.spyOn(host, 'addEventListener');
  const removeSpy = vi.spyOn(host, 'removeEventListener');
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(ReelBackdrop, { target, props: { host, active } });
  flushSync();
  return { host, target, component, addSpy, removeSpy };
}

it('renders and listens nothing when the frame fills the stage', () => {
  const { video } = fakeVideo();
  const { target, addSpy } = setup(false, video);
  expect(target.querySelector('[data-reel-backdrop]')).toBeNull();
  expect(addSpy).not.toHaveBeenCalled();
  expect(paint).not.toHaveBeenCalled();
});

it('reads a video on its first presented frame after playing, not before, and once', () => {
  const fake = fakeVideo();
  setup(true, fake.video);
  expect(paint).not.toHaveBeenCalled();
  fake.video.dispatchEvent(new Event('playing'));
  expect(paint).not.toHaveBeenCalled();
  fake.present();
  expect(paint).toHaveBeenCalledTimes(1);
  // A loop's seek fires `playing` again: the same source is not read again.
  fake.video.dispatchEvent(new Event('playing'));
  expect(fake.pendingFrames()).toBe(0);
  expect(paint).toHaveBeenCalledTimes(1);
});

it('retries a blank read on the next presented frame, a bounded number of times', () => {
  paint.mockReturnValue('blank');
  const fake = fakeVideo();
  setup(true, fake.video);
  fake.video.dispatchEvent(new Event('playing'));
  for (let i = 0; i < 10; i++) fake.present();
  expect(paint).toHaveBeenCalledTimes(5);
  expect(fake.pendingFrames()).toBe(0);
});

it('stops retrying as soon as a read paints', () => {
  paint.mockReturnValueOnce('blank').mockReturnValue('painted');
  const fake = fakeVideo();
  setup(true, fake.video);
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  fake.present();
  fake.present();
  expect(paint).toHaveBeenCalledTimes(2);
});

it('repaints when the same element is handed another stream (a lens switch)', () => {
  const first = { id: 'front' };
  const fake = fakeVideo(first);
  setup(true, fake.video);
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  fake.setSource({ id: 'rear' });
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  expect(paint).toHaveBeenCalledTimes(2);
});

it('reads an image on load, once', () => {
  const img = document.createElement('img');
  Object.defineProperty(img, 'complete', { get: () => false });
  Object.defineProperty(img, 'currentSrc', { get: () => 'blob:photo-1' });
  setup(true, img);
  expect(paint).not.toHaveBeenCalled();
  img.dispatchEvent(new Event('load'));
  img.dispatchEvent(new Event('load'));
  expect(paint).toHaveBeenCalledTimes(1);
});

it('has no per-frame work: no timer, no animation frame, no second video', () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
  const fake = fakeVideo();
  const { target, host } = setup(true, fake.video);
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  expect(interval).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  expect(raf).not.toHaveBeenCalled();
  expect(target.querySelectorAll('video')).toHaveLength(0);
  expect(host.querySelectorAll('video')).toHaveLength(1);
});

it('removes its listeners on unmount', () => {
  const { video } = fakeVideo();
  const { component, removeSpy } = setup(true, video);
  void unmount(component);
  expect(removeSpy).toHaveBeenCalledWith('playing', expect.any(Function), true);
  expect(removeSpy).toHaveBeenCalledWith('load', expect.any(Function), true);
});
