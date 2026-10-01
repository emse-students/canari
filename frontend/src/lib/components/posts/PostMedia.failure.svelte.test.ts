/**
 * A POST MEDIA THAT CANNOT BE SHOWN SAYS WHY, AND OFFERS A RETRY WHEN ONE CAN HELP (2026-10-01).
 *
 * It said "Impossible de charger le media" for everything but a purge. Pinned, per cause: the
 * sentence, whether "Reessayer" is drawn (never for a 404 or a purge), and that it downloads again
 * in place - the component, not the page, starts over.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import {
  MediaDecryptError,
  MediaDownloadError,
  MediaNotFoundError,
  MediaPurgedError,
  MediaUnreachableError,
} from '$lib/utils/mediaErrors';
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
  vi.restoreAllMocks();
});

async function mountFailing(err: unknown) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  download.mockRejectedValue(err);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: {
      media: { type: 'image', mediaId: 'm1', key: 'k', iv: 'iv', mimeType: 'image/jpeg', size: 1 },
      authToken: 'token',
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  await tick();
  await tick();
  flushSync();
  return target;
}

const retryButton = (t: HTMLElement) =>
  Array.from(t.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(m.media_retry_button())
  );

describe('PostMedia names the cause of a failure', () => {
  // The sentence is read when the assertion runs, never when the table is built: the table is built
  // at collection, before the component's imports have settled the locale it renders in.
  it.each([
    ['unreachable', new MediaUnreachableError(new TypeError('x')), m.media_error_unreachable, true],
    ['not found', new MediaNotFoundError(), m.media_error_not_found, false],
    ['expired', new MediaPurgedError(), m.post_media_expired_label, false],
    ['corrupt', new MediaDecryptError(new Error('x')), m.media_error_corrupt, true],
    ['other', new MediaDownloadError(500), m.post_image_load_error, true],
  ])('%s', async (_name, err, text, retryable) => {
    const target = await mountFailing(err);
    expect(target.textContent).toContain(text());
    expect(!!retryButton(target)).toBe(retryable);
  });

  it('"Reessayer" downloads again in place, and draws the media when it arrives', async () => {
    const target = await mountFailing(new MediaUnreachableError(new TypeError('x')));
    download.mockResolvedValue('blob:second');

    retryButton(target)!.click();
    flushSync();
    await tick();
    await tick();
    flushSync();

    expect(download).toHaveBeenCalledTimes(2);
    expect(target.querySelector('img')?.getAttribute('src')).toBe('blob:second');
  });
});
