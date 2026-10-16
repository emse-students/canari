/**
 * The backdrop paints ONCE per picture and has no per-frame work: no timer, no animation frame, no
 * second video (Mi 9T, 2026-10-16: a 250 ms re-sample cost ~25 ms a read and holed the camera's take).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const paint = vi.hoisted(() => vi.fn(() => true));
vi.mock('$lib/reels/reelBackdropPaint', () => ({ paintBlurredBackdrop: paint }));

import ReelBackdrop from './ReelBackdrop.svelte';

beforeEach(() => paint.mockClear());

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function setup(active: boolean, readyState = 4) {
  const host = document.createElement('div');
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => readyState });
  Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => 'blob:reel-1' });
  host.append(video);
  document.body.append(host);
  const addSpy = vi.spyOn(host, 'addEventListener');
  const removeSpy = vi.spyOn(host, 'removeEventListener');
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(ReelBackdrop, { target, props: { host, active } });
  flushSync();
  return { host, video, target, component, addSpy, removeSpy };
}

it('renders and listens nothing when the frame fills the stage', () => {
  const { target, addSpy } = setup(false);
  expect(target.querySelector('[data-reel-backdrop]')).toBeNull();
  expect(addSpy).not.toHaveBeenCalled();
  expect(paint).not.toHaveBeenCalled();
});

it('paints once, and a second loadeddata of the same picture paints nothing', () => {
  const { video } = setup(true);
  expect(paint).toHaveBeenCalledTimes(1);
  video.dispatchEvent(new Event('loadeddata'));
  expect(paint).toHaveBeenCalledTimes(1);
});

it('waits for the first decoded frame of a video before painting', () => {
  let ready = 0;
  const { video } = setup(true, 0);
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => ready });
  expect(paint).not.toHaveBeenCalled();
  ready = 2;
  video.dispatchEvent(new Event('loadeddata'));
  expect(paint).toHaveBeenCalledTimes(1);
});

it('has no per-frame work: no timer, no animation frame, no second video', () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
  const { target, host } = setup(true);
  expect(interval).not.toHaveBeenCalled();
  expect(raf).not.toHaveBeenCalled();
  expect(target.querySelectorAll('video')).toHaveLength(0);
  expect(host.querySelectorAll('video')).toHaveLength(1);
});

it('removes its listeners on unmount', () => {
  const { component, removeSpy } = setup(true);
  void unmount(component);
  expect(removeSpy).toHaveBeenCalledWith('loadeddata', expect.any(Function), true);
  expect(removeSpy).toHaveBeenCalledWith('load', expect.any(Function), true);
});
