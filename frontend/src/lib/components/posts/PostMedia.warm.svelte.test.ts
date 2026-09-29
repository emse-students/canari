/**
 * A MEDIA ALREADY DECRYPTED IN MEMORY IS DRAWN AT ONCE, DEFERRED OR NOT (Mi 9T, 2026-09-29).
 *
 * A feed rebuilt by a tab swipe held every one of its media, yet each card waited for its
 * `nearViewport` observer - a frame after the first paint - and drew its loading placeholder first.
 * Pinned: a warm media renders in the first flush with no download; a cold deferred one still waits,
 * because deferring exists to spare the network.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn<() => string | null>(),
  releaseDecryptedMediaBlobUrl: vi.fn(),
}));
const download = vi.hoisted(() => vi.fn(async () => 'blob:downloaded'));

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));

import PostMedia from './PostMedia.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function mountMedia() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: {
      media: {
        type: 'image',
        mediaId: 'm1',
        key: 'k',
        iv: 'iv',
        mimeType: 'image/jpeg',
        size: 10,
      },
      authToken: 'token',
      deferred: true,
      letterbox: false,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

it('draws a media already in memory in the first flush, with no download', () => {
  cache.retainWarmDecryptedMediaBlobUrl.mockReturnValue('blob:warm');
  const target = mountMedia();

  expect(target.querySelector('img')?.getAttribute('src')).toBe('blob:warm');
  expect(download).not.toHaveBeenCalled();
});

it('keeps a cold media deferred: placeholder, and no download yet', () => {
  cache.retainWarmDecryptedMediaBlobUrl.mockReturnValue(null);
  const target = mountMedia();

  expect(target.querySelector('img')).toBeNull();
  expect(target.querySelector('.animate-pulse')).not.toBeNull();
  expect(download).not.toHaveBeenCalled();
});
