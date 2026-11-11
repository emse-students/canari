// @vitest-environment happy-dom
/**
 * THE REEL'S "PLEIN ECRAN" CHIP OPENS PostMedia'S OWN VIEWER (owner, 2026-11-11), forced to
 * landscape, from the blob this component already holds: one download, no second fetch. The pager is
 * told the viewer opened and closed (`onViewerChange`) so it can yield its keys.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn(() => null),
  releaseDecryptedMediaBlobUrl: vi.fn(),
}));
const download = vi.hoisted(() => vi.fn<() => Promise<string>>());
const orientation = vi.hoisted(() => ({
  release: vi.fn(),
  request: vi.fn((_mode: string, _owner: string) => ({ release: orientation.release })),
}));

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));
vi.mock('$lib/mobile/screenOrientation.svelte', () => ({
  requestOrientation: (mode: string, owner: string) => orientation.request(mode, owner),
}));
vi.mock('$lib/actions/playWhileVisible', async (orig) => ({
  ...(await orig<typeof import('$lib/actions/playWhileVisible')>()),
  holdPlayback: () => () => {},
}));

import PostMedia from './PostMedia.svelte';

const VIDEO = {
  type: 'video' as const,
  mediaId: 'v-ls',
  key: 'k',
  iv: 'iv',
  mimeType: 'video/mp4',
  size: 1,
  width: 1920,
  height: 1080,
};
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  download.mockImplementation(() => Promise.resolve('blob:clip'));
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mountReel(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: {
      media: VIDEO,
      authToken: 'token',
      galleryMode: true,
      minimalPlayer: true,
      ...props,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  await tick();
  await tick();
  flushSync();
}

const chip = () => document.querySelector<HTMLButtonElement>('[data-reel-fullscreen]');

it('draws no chip when the caller did not ask for the landscape viewer', async () => {
  await mountReel({});
  expect(chip()).toBeNull();
});

it('the chip opens the forced-landscape viewer on the blob already held, no second fetch', async () => {
  const onViewerChange = vi.fn();
  await mountReel({ landscapeViewer: true, onViewerChange });
  expect(download).toHaveBeenCalledTimes(1);
  expect(chip()).not.toBeNull();
  expect(orientation.request).not.toHaveBeenCalled();

  chip()!.click();
  flushSync();
  await tick();
  flushSync();

  expect(orientation.request).toHaveBeenCalledWith('landscape', 'media-lightbox');
  expect(onViewerChange).toHaveBeenLastCalledWith(true);
  expect(download, 'the viewer reuses the held blob').toHaveBeenCalledTimes(1);
  const players = [...document.querySelectorAll('video')];
  expect(players.some((v) => v.getAttribute('src') === 'blob:clip')).toBe(true);
});
