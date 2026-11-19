// @vitest-environment happy-dom
/**
 * The review is NOT a player (user, 2026-10-09: black bars after a capture): the take fills the
 * screen under `object-cover`, loops, and carries no seek bar, timecode or bottom sound button.
 * Pencil, sound and cross live at the top; "Next" floats over the bottom edge.
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

it("shows no native poster until the take's first frame", () => {
  const target = mountReview({});
  expect(target.querySelector('video')!.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
});

it('fills the screen with the media: no letterbox, looping, no player controls', () => {
  const target = mountReview({});
  const video = target.querySelector('video')!;
  expect(video.className).toContain('object-cover');
  expect(video.className).not.toContain('object-contain');
  expect(video.className).toContain('absolute inset-0');
  expect(video.loop).toBe(true);
  expect(video.autoplay).toBe(true);
  expect(video.hasAttribute('controls')).toBe(false);
  expect(target.querySelector('[data-video-controls]')).toBeNull();
  expect(target.querySelector('[data-video-player]')).toBeNull();
  expect(target.querySelector('input[type="range"]')).toBeNull();
});

it('keeps pencil, sound and cross together at the TOP, and "Next" over the bottom edge', () => {
  const target = mountReview({});
  const top = target.querySelector('[data-reel-sound]')!.closest('.top-0')!;
  expect(top.querySelectorAll('button').length).toBe(3);
  const bar = target.querySelector('[data-reel-review-bar]')!;
  expect(bar.contains(target.querySelector('[data-reel-next]'))).toBe(true);
  expect(bar.className).toContain('bottom-0');
  expect(bar.className).toContain('safe-area-inset-bottom');
  expect(top.contains(bar)).toBe(false);
});

it('draws a photo full-bleed too', () => {
  const target = mountReview({
    clip: { blob: new Blob(['x'], { type: 'image/webp' }), source: 'camera' },
  });
  expect(target.querySelector('img')!.className).toContain('object-cover');
});

it('removes the sound on the CLIP, keeps the preview silent, and says so', () => {
  const changes: boolean[] = [];
  const target = mountReview({ onsoundchange: (removed: boolean) => changes.push(removed) });
  const button = target.querySelector<HTMLButtonElement>('[data-reel-sound]')!;
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(target.querySelector('[data-reel-sound-removed]')).toBeNull();
  expect(target.querySelector('video')!.muted).toBe(false);
  button.click();
  expect(changes).toEqual([true]);

  const removed = mountReview({
    clip: { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera', soundRemoved: true },
    onsoundchange: (value: boolean) => changes.push(value),
  });
  expect(removed.querySelector('[data-reel-sound-removed]')).not.toBeNull();
  expect(removed.querySelector('video')!.muted).toBe(true);
  removed.querySelector<HTMLButtonElement>('[data-reel-sound]')!.click();
  expect(changes).toEqual([true, false]);
});

it('offers no sound button for a photo', () => {
  const target = mountReview({
    clip: { blob: new Blob(['x'], { type: 'image/webp' }), source: 'camera' },
  });
  expect(target.querySelector('[data-reel-sound]')).toBeNull();
});

it('WITHOUT a second action the bar holds the one "Next", at its right edge, as before', () => {
  const target = mountReview({ nextLabel: 'Suivant' });
  const bar = target.querySelector('[data-reel-review-bar]')!;
  expect(target.querySelector('[data-reel-secondary]')).toBeNull();
  expect(bar.className).toContain('justify-end');
  expect(target.querySelector('[data-reel-next]')!.textContent?.trim()).toBe('Suivant');
});

it('TWO ACTIONS (section 22): the secondary on the left, the primary on the right, each its own handler', () => {
  const onnext = vi.fn();
  const onsecondary = vi.fn();
  const target = mountReview({
    nextLabel: 'Send to...',
    onnext,
    secondaryLabel: 'Publier',
    onsecondary,
  });
  const bar = target.querySelector('[data-reel-review-bar]')!;
  const secondary = target.querySelector<HTMLButtonElement>('[data-reel-secondary]')!;
  const next = target.querySelector<HTMLButtonElement>('[data-reel-next]')!;
  expect(bar.className).toContain('justify-between');
  expect(secondary.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(secondary.textContent?.trim()).toBe('Publier');
  secondary.click();
  expect(onsecondary).toHaveBeenCalledTimes(1);
  expect(onnext).not.toHaveBeenCalled();
  next.click();
  expect(onnext).toHaveBeenCalledTimes(1);
});

it("a ONE-TAP SEND reads the conversation's name, carries an accessible sentence and the send glyph", () => {
  const target = mountReview({
    nextLabel: 'Paul',
    nextAriaLabel: 'Send to Paul',
    nextIcon: 'send',
  });
  const next = target.querySelector<HTMLButtonElement>('[data-reel-next]')!;
  expect(next.textContent?.trim()).toBe('Paul');
  expect(next.getAttribute('aria-label')).toBe('Send to Paul');
  expect(next.querySelector('svg')!.getAttribute('class')).toContain('lucide-send');
});
