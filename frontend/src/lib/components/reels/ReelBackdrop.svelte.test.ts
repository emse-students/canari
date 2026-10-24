// @vitest-environment happy-dom
/**
 * The backdrop paints ONCE per source, on an event, and has no per-frame work: no timer, no animation
 * frame, no second video (Mi 9T, 2026-10-16: a 250 ms re-sample cost ~25 ms a read and holed the
 * camera's take). A video is read on its next presented frame after `playing` / `loadeddata`; a blank
 * read waits for the next presented frame, a bounded number of times, per source.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import {
  EXPOSURE_MAX_SAMPLES,
  EXPOSURE_SAMPLE_STRIDE,
  type BackdropPaintResult,
} from '$lib/reels/reelBackdropPaint';

const paint = vi.hoisted(() => vi.fn((): BackdropPaintResult => 'painted'));
const read = vi.hoisted(() => vi.fn());
const blur = vi.hoisted(() => vi.fn(() => 'painted'));
vi.mock('$lib/reels/reelBackdropPaint', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/reelBackdropPaint')>()),
  paintBlurredBackdrop: paint,
  readBackdropSample: read,
  blurSampleInto: blur,
}));

import ReelBackdrop from './ReelBackdrop.svelte';

beforeEach(() => {
  paint.mockReset();
  paint.mockReturnValue('painted');
  read.mockReset();
  blur.mockReset();
  blur.mockReturnValue('painted');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface FakeOptions {
  src?: unknown;
  paused?: boolean;
  readyState?: number;
  frameCallbacks?: boolean;
}

/** A video whose presented frames the test delivers by hand. */
function fakeVideo({
  src = 'blob:reel-1',
  paused = false,
  readyState = 0,
  frameCallbacks = true,
}: FakeOptions = {}) {
  const video = document.createElement('video');
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextHandle = 1;
  let source = src;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => readyState });
  Object.defineProperty(video, 'currentSrc', {
    configurable: true,
    get: () => (typeof source === 'string' ? source : ''),
  });
  Object.defineProperty(video, 'srcObject', {
    configurable: true,
    get: () => (typeof source === 'string' ? null : source),
  });
  if (frameCallbacks) {
    Object.assign(video, {
      requestVideoFrameCallback: (cb: () => void) => {
        const handle = nextHandle++;
        callbacks.set(handle, cb);
        return handle;
      },
      cancelVideoFrameCallback: (handle: number) => {
        cancelled.push(handle);
        callbacks.delete(handle);
      },
    });
  }
  return {
    video,
    cancelled,
    setSource: (next: unknown) => (source = next),
    pendingFrames: () => callbacks.size,
    /** Presents one frame: runs the callbacks registered so far. */
    present: () => {
      const due = [...callbacks.values()];
      callbacks.clear();
      due.forEach((cb) => cb());
    },
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
  const { video } = fakeVideo({ paused: true });
  const { target, addSpy } = setup(false, video);
  expect(target.querySelector('[data-reel-backdrop]')).toBeNull();
  expect(addSpy).not.toHaveBeenCalled();
  expect(paint).not.toHaveBeenCalled();
});

it('reads a video on its first presented frame after playing, not before, and once', () => {
  const fake = fakeVideo({ paused: true });
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
  for (let i = 0; i < 10; i++) fake.present();
  expect(paint).toHaveBeenCalledTimes(5);
  expect(fake.pendingFrames()).toBe(0);
  // Given up for this source: another `playing` does not start a new chain.
  fake.video.dispatchEvent(new Event('playing'));
  expect(fake.pendingFrames()).toBe(0);
});

it('gives a new source its own full count after the old one ran out', () => {
  paint.mockReturnValue('blank');
  const fake = fakeVideo({ src: { id: 'front' } });
  setup(true, fake.video);
  for (let i = 0; i < 5; i++) fake.present();
  expect(paint).toHaveBeenCalledTimes(5);
  fake.setSource({ id: 'rear' });
  fake.video.dispatchEvent(new Event('loadeddata'));
  for (let i = 0; i < 10; i++) fake.present();
  expect(paint).toHaveBeenCalledTimes(10);
});

it('stops retrying as soon as a read paints', () => {
  paint.mockReturnValueOnce('blank').mockReturnValue('painted');
  const fake = fakeVideo();
  setup(true, fake.video);
  fake.present();
  fake.present();
  fake.present();
  expect(paint).toHaveBeenCalledTimes(2);
});

it('cancels the pending frame callback when the element takes another stream (a lens switch)', () => {
  const fake = fakeVideo({ src: { id: 'front' } });
  setup(true, fake.video);
  expect(fake.pendingFrames()).toBe(1);
  fake.setSource({ id: 'rear' });
  fake.video.dispatchEvent(new Event('playing'));
  expect(fake.cancelled).toEqual([1]);
  expect(fake.pendingFrames()).toBe(1);
  fake.present();
  expect(paint).toHaveBeenCalledTimes(1);
  fake.setSource({ id: 'front-again' });
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  expect(paint).toHaveBeenCalledTimes(2);
});

it('reads a video paused on a frame already on screen at once (review, editor)', () => {
  const fake = fakeVideo({ paused: true, readyState: 2 });
  setup(true, fake.video);
  expect(paint).toHaveBeenCalledTimes(1);
  expect(fake.pendingFrames()).toBe(0);
});

it('reads a paused video on the frame its loadeddata presents', () => {
  const fake = fakeVideo({ paused: true });
  setup(true, fake.video);
  fake.video.dispatchEvent(new Event('loadeddata'));
  fake.present();
  expect(paint).toHaveBeenCalledTimes(1);
});

it('warns once per source when the engine has no frame callback', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fake = fakeVideo({ paused: true, frameCallbacks: false });
  setup(true, fake.video);
  fake.video.dispatchEvent(new Event('playing'));
  fake.video.dispatchEvent(new Event('playing'));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(paint).not.toHaveBeenCalled();
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
  fake.present();
  expect(interval).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  expect(raf).not.toHaveBeenCalled();
  expect(target.querySelectorAll('video')).toHaveLength(0);
  expect(host.querySelectorAll('video')).toHaveLength(1);
});

it('removes its listeners and cancels its frame callback on unmount', () => {
  const fake = fakeVideo();
  const { component, removeSpy } = setup(true, fake.video);
  void unmount(component);
  expect(removeSpy).toHaveBeenCalledWith('playing', expect.any(Function), true);
  expect(removeSpy).toHaveBeenCalledWith('loadeddata', expect.any(Function), true);
  expect(removeSpy).toHaveBeenCalledWith('load', expect.any(Function), true);
  expect(fake.cancelled).toEqual([1]);
});

/** A read of the camera whose mean colour is `mean`. */
function sampleOf(mean: [number, number, number]) {
  return { canvas: document.createElement('canvas'), width: 12, height: 21, mean };
}

it('repaints a live camera ONCE, from the first read that agrees with the one before it', () => {
  // Under-exposed, then converging, then settled (Mi 9T, v1.2.9-alpha.4: near black over a grey wall).
  read
    .mockReturnValueOnce(sampleOf([20, 30, 40]))
    .mockReturnValueOnce(sampleOf([90, 90, 92]))
    .mockReturnValueOnce(sampleOf([120, 118, 121]))
    .mockReturnValueOnce(sampleOf([122, 120, 119]));
  const fake = fakeVideo({ src: { id: 'camera' } });
  setup(true, fake.video);
  fake.present();
  expect(paint).toHaveBeenCalledTimes(1);

  // Read every EXPOSURE_SAMPLE_STRIDE presented frames, never in between.
  for (let i = 0; i < EXPOSURE_SAMPLE_STRIDE - 1; i++) fake.present();
  expect(read).not.toHaveBeenCalled();
  fake.present();
  expect(read).toHaveBeenCalledTimes(1);

  for (let i = 0; i < EXPOSURE_SAMPLE_STRIDE * 10; i++) fake.present();
  expect(read).toHaveBeenCalledTimes(4);
  expect(blur).toHaveBeenCalledTimes(1);
  expect((blur.mock.calls[0] as unknown[])[1]).toMatchObject({ mean: [122, 120, 119] });
  expect(fake.pendingFrames()).toBe(0);
  // The same stream is never read again.
  fake.video.dispatchEvent(new Event('playing'));
  expect(fake.pendingFrames()).toBe(0);
});

it('paints the last read when the exposure never settles within the bound', () => {
  let level = 0;
  read.mockImplementation(() => sampleOf([(level += 40), level, level]));
  const fake = fakeVideo({ src: { id: 'camera' } });
  setup(true, fake.video);
  for (let i = 0; i < 1 + EXPOSURE_SAMPLE_STRIDE * (EXPOSURE_MAX_SAMPLES + 4); i++) fake.present();
  expect(read).toHaveBeenCalledTimes(EXPOSURE_MAX_SAMPLES);
  expect(blur).toHaveBeenCalledTimes(1);
  expect(fake.pendingFrames()).toBe(0);
});

it('says the repaint did not happen when the engine gave no context', () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  read.mockReturnValue(sampleOf([100, 100, 100]));
  blur.mockReturnValue('no-context');
  const fake = fakeVideo({ src: { id: 'camera' } });
  setup(true, fake.video);
  for (let i = 0; i < 1 + EXPOSURE_SAMPLE_STRIDE * 2; i++) fake.present();
  expect(blur).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('not repainted'));
  expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('[reel-backdrop] repainted'));
});

it('does not re-read a file: its first frame is its picture', () => {
  const fake = fakeVideo({ src: 'blob:reel-1' });
  setup(true, fake.video);
  for (let i = 0; i < EXPOSURE_SAMPLE_STRIDE * 4; i++) fake.present();
  expect(paint).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
});

it('a lens switch cancels the settle of the stream it replaces', () => {
  read.mockReturnValue(sampleOf([100, 100, 100]));
  const fake = fakeVideo({ src: { id: 'front' } });
  setup(true, fake.video);
  fake.present();
  fake.setSource({ id: 'rear' });
  fake.video.dispatchEvent(new Event('playing'));
  fake.present();
  expect(paint).toHaveBeenCalledTimes(2);
  expect(read).not.toHaveBeenCalled();
});
