// @vitest-environment happy-dom
/**
 * THE "PLEIN ECRAN" CHIP IS PER MEDIA (owner, 2026-11-11): a reel pane asks its player for the
 * landscape viewer only when THAT video's own file is wider than tall, never for a portrait or
 * square file, a file with no recorded size, or a neighbour that mounts no player.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelMediaPane from './ReelMediaPane.svelte';
import { resetLandscapeMediaLogForTest } from '$lib/reels/landscapeMedia';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
  worthPreloading: () => false,
}));
vi.mock('$lib/reels/reelPosters.svelte', () => ({
  reelPosterUrl: () => null,
  captureReelPoster: async () => {},
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  resetLandscapeMediaLogForTest();
});

function pane(dims: { width?: number; height?: number }, active = true) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const media = { mediaId: 'm1', fileName: 'v.mp4', mimeType: 'video/mp4', ...dims };
  const component = mount(ReelMediaPane, {
    target,
    props: {
      postId: 'p1',
      media: media as never,
      kind: 'video',
      authToken: 't',
      active,
      preload: false,
      show: true,
      playerSafeBottom: true,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target.querySelector('[data-post-media-stub]');
}

it('asks for the landscape viewer when the file is wider than tall', () => {
  expect(pane({ width: 1920, height: 1080 })?.hasAttribute('data-landscape-viewer')).toBe(true);
});

it('does not for a portrait file, a square one, or one with no recorded size', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(pane({ width: 1080, height: 1920 })?.hasAttribute('data-landscape-viewer')).toBe(false);
  expect(pane({ width: 900, height: 900 })?.hasAttribute('data-landscape-viewer')).toBe(false);
  expect(pane({})?.hasAttribute('data-landscape-viewer')).toBe(false);
  warn.mockRestore();
});

it('a neighbour pane mounts no player, so it draws no chip', () => {
  expect(pane({ width: 1920, height: 1080 }, false)).toBeNull();
});
