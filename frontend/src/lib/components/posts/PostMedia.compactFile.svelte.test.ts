// @vitest-environment happy-dom
/**
 * A COMPACT DOCUMENT ROW (owner, 2026-11-02): icon, name, size and a download button, no first-page
 * preview, and NO DOWNLOAD UNTIL THE READER ASKS - a post of ten PDFs is ten rows, not ten fetches.
 * The tap on a PDF row then fetches the file for the viewer; the full card (a lone document) is
 * unchanged.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const download = vi.hoisted(() => vi.fn(async () => 'blob:downloaded'));
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));
vi.mock('$lib/components/shared/PdfThumbnail.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/PdfViewerModal.svelte', async () => ({
  default: (await import('./MediaLightboxStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/mediaBlobCache', () => ({
  retainWarmDecryptedMediaBlobUrl: () => null,
  releaseDecryptedMediaBlobUrl: vi.fn(),
  adoptDecryptedMediaBlob: vi.fn(),
}));

import PostMedia from './PostMedia.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function mountFile(compact: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: {
      media: {
        type: 'file',
        mediaId: 'f1',
        key: 'k',
        iv: 'iv',
        mimeType: 'application/pdf',
        size: 2048,
        fileName: 'cours.pdf',
      },
      authToken: 'token',
      compact,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

it('draws the row at once from metadata, with no download and no preview', () => {
  const target = mountFile(true);
  expect(target.textContent).toContain('cours.pdf');
  expect(target.querySelector(`[aria-label="${m.post_download_label()}"]`)).not.toBeNull();
  expect(target.querySelector('[data-post-media-open]')).toBeNull();
  expect(download).not.toHaveBeenCalled();
});

it('fetches the file only when the reader taps the row', async () => {
  const target = mountFile(true);
  target.querySelector<HTMLButtonElement>(`[aria-label="${m.pdf_open_document_label()}"]`)!.click();
  flushSync();
  await tick();
  await tick();
  expect(download).toHaveBeenCalledTimes(1);
});

it('keeps the first-page preview on the full card, downloaded as before', async () => {
  const target = mountFile(false);
  await tick();
  await tick();
  expect(download).toHaveBeenCalledTimes(1);
  expect(target.querySelector('[data-post-media-open]')).not.toBeNull();
});
