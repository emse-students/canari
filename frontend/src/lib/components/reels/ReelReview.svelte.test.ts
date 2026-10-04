/**
 * A take is reviewed on Canari's own poster, never the engine's (user, 2026-10-02, Mi 9T: Android's
 * native video glyph showed right after a recording, before the video loaded). The review is the
 * real `VideoPlayer`, so this pins what the reel flow relies on: the element's `poster` is the
 * transparent one, Canari's poster covers the full-screen box until the first frame, and the box
 * has its final size from the first paint.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelReview from './ReelReview.svelte';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows Canari's poster and no native one until the take's first frame", () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelReview, {
      target,
      props: {
        clip: { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' },
        ondiscard: () => {},
        onnext: () => {},
      },
    })
  );
  flushSync();
  const video = target.querySelector('video')!;
  expect(video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
  expect(video.className).toContain('h-full');
  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).not.toBeNull();

  video.dispatchEvent(new Event('loadeddata'));
  flushSync();
  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).toBeNull();
});

it('shows a captured photo as an image in the review', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelReview, {
      target,
      props: {
        clip: { blob: new Blob(['x'], { type: 'image/webp' }), source: 'camera' },
        ondiscard: () => {},
        onedit: () => {},
        onnext: () => {},
      },
    })
  );
  flushSync();
  expect(target.querySelector('img')).not.toBeNull();
  expect(target.querySelector('video')).toBeNull();
});
