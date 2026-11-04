// @vitest-environment happy-dom
/**
 * A REEL'S DOWNLOAD IS SAID, NOT HIDDEN (Mi 9T, 400 kbps, v1.6.4-alpha.4): the full-screen media page
 * drew a static image icon for the whole ~55 s read, and #3015's spinner appeared only once the
 * player had mounted. Pinned: from the moment the fetch starts until the media is in, the page
 * carries the shared spinner (named, a status), over the first-frame poster when there is one; once
 * the file is in, the spinner is gone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn(() => null),
  releaseDecryptedMediaBlobUrl: vi.fn(),
}));
const download = vi.hoisted(() => vi.fn<() => Promise<string>>());

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

function mountGallery(extra: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: {
      media: { type: 'image', mediaId: 'm1', key: 'k', iv: 'iv', mimeType: 'image/jpeg', size: 1 },
      authToken: 'token',
      galleryMode: true,
      ...extra,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

describe('PostMedia, gallery mode, while the file downloads', () => {
  it('shows the named spinner and no static image icon', () => {
    download.mockReturnValue(new Promise(() => {}));
    const target = mountGallery();
    const spinner = target.querySelector('[data-video-buffering]');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(spinner?.getAttribute('aria-label')).toBe(m.video_loading_label());
    expect(target.querySelector('.lucide-image')).toBeNull();
  });

  it('keeps the first-frame poster under the spinner', () => {
    download.mockReturnValue(new Promise(() => {}));
    const target = mountGallery({ poster: 'data:image/png;base64,AAAA' });
    expect(target.querySelector('[data-video-first-frame-poster]')).not.toBeNull();
    expect(target.querySelector('[data-video-buffering]')).not.toBeNull();
  });

  it('removes the spinner once the file is in', async () => {
    download.mockResolvedValue('blob:done');
    const target = mountGallery();
    await tick();
    await tick();
    flushSync();
    expect(target.querySelector('[data-video-buffering]')).toBeNull();
  });
});
