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

function mountReview(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelReview, {
      target,
      props: {
        clip: { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' },
        ondiscard: () => {},
        onnext: () => {},
        ...props,
      },
    })
  );
  flushSync();
  return target;
}

it('puts "Next" in a bar of its own, never over the player and its controls', () => {
  const target = mountReview({});
  const next = target.querySelector('[data-reel-next]')!;
  const player = target.querySelector('[data-video-player]')!;
  expect(player.contains(next)).toBe(false);
  expect(target.querySelector('[data-video-controls]')!.contains(next)).toBe(false);
  // The bar is a sibling of the take's area, in the same column, and owns the bottom inset.
  const bar = target.querySelector('[data-reel-review-bar]')!;
  expect(bar.contains(next)).toBe(true);
  expect(bar.className).toContain('safe-area-inset-bottom');
  expect(bar.parentElement!.className).toContain('flex-col');
  // So the player does not pad for the home indicator a second time.
  expect(target.querySelector('[data-video-controls]')!.className).not.toContain(
    'env(safe-area-inset-bottom)'
  );
});

it('removes the sound on the CLIP, keeps the preview silent, and says so', () => {
  const changes: boolean[] = [];
  const target = mountReview({ onsoundchange: (removed: boolean) => changes.push(removed) });
  const button = target.querySelector<HTMLButtonElement>('[data-reel-sound]')!;
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(target.querySelector('[data-reel-sound-removed]')).toBeNull();
  button.click();
  expect(changes).toEqual([true]);

  const removed = mountReview({
    clip: { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera', soundRemoved: true },
    onsoundchange: (value: boolean) => changes.push(value),
  });
  expect(removed.querySelector('[data-reel-sound-removed]')).not.toBeNull();
  const video = removed.querySelector('video')!;
  expect(video.muted).toBe(true);
  // The player's own listening toggle is out of play: what is heard is what is published.
  const listening = removed.querySelector<HTMLButtonElement>(
    '[data-video-controls] button[aria-pressed]'
  )!;
  expect(listening.disabled).toBe(true);
  removed.querySelector<HTMLButtonElement>('[data-reel-sound]')!.click();
  expect(changes).toEqual([true, false]);
});

it('offers no sound button for a photo', () => {
  const target = mountReview({
    clip: { blob: new Blob(['x'], { type: 'image/webp' }), source: 'camera' },
  });
  expect(target.querySelector('[data-reel-sound]')).toBeNull();
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
