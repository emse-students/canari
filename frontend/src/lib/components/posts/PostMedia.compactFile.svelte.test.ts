// @vitest-environment happy-dom
/**
 * A COMPACT DOCUMENT ROW (owner, 2026-11-02): icon, name, size and a download button, no first-page
 * preview, and NO DOWNLOAD UNTIL THE READER ASKS - a post of ten PDFs is ten rows, not ten fetches.
 *
 * What is pinned: the row costs nothing; a tap shows it is working and keeps the FIRST request
 * (a second tap is ignored); an OPEN runs once the file is in, a SAVE waits for a tap of its own
 * (a download started from an effect is outside the gesture WKWebView and Tauri require); a
 * failure drops the request and a retry leaves the row ready; and a tap beats `deferred`.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { MediaUnreachableError } from '$lib/utils/mediaErrors';

const download = vi.hoisted(() => vi.fn<() => Promise<string>>());
const save = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: save }));
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
  vi.restoreAllMocks();
});

function mountFile(
  compact: boolean,
  extra: Record<string, unknown> = {},
  mimeType = 'application/pdf'
) {
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
        mimeType,
        size: 2048,
        fileName: 'cours.pdf',
      },
      authToken: 'token',
      compact,
      ...extra,
    },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
  flushSync();
};
const rowButton = (t: HTMLElement) =>
  t.querySelector<HTMLButtonElement>(`[aria-label="${m.pdf_open_document_label()}"]`)!;
const downloadButton = (t: HTMLElement) =>
  t.querySelector<HTMLButtonElement>(`[aria-label="${m.post_download_label()}"]`)!;
const card = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-file-card]')!;
const viewerOpen = (t: HTMLElement) => t.ownerDocument.querySelector('[data-lightbox]') !== null;

/** A download the test settles by hand, to observe the row while it is in flight. */
function slowDownload() {
  let finish!: (url: string) => void;
  let fail!: (err: unknown) => void;
  download.mockImplementationOnce(
    () =>
      new Promise<string>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      })
  );
  return { finish: (url = 'blob:downloaded') => finish(url), fail: (err: unknown) => fail(err) };
}

it('draws the row at once from metadata, with no download and no preview', () => {
  const target = mountFile(true);
  expect(target.textContent).toContain('cours.pdf');
  expect(downloadButton(target)).not.toBeNull();
  expect(target.querySelector('[data-post-media-open]')).toBeNull();
  expect(card(target).getAttribute('aria-busy')).toBe('false');
  expect(download).not.toHaveBeenCalled();
});

it('shows it is working after a tap, then opens the viewer once the file is in', async () => {
  const target = mountFile(true);
  const slow = slowDownload();
  rowButton(target).click();
  flushSync();
  await tick();

  expect(card(target).getAttribute('aria-busy')).toBe('true');
  expect(target.querySelector('[data-file-spinner]')).not.toBeNull();
  expect(viewerOpen(target)).toBe(false);

  slow.finish();
  await settle();
  expect(viewerOpen(target)).toBe(true);
  expect(card(target).getAttribute('aria-busy')).toBe('false');
  expect(save).not.toHaveBeenCalled();
});

it('a save is NOT run from the effect: the row turns "ready", and the next tap saves', async () => {
  const target = mountFile(true);
  const slow = slowDownload();
  downloadButton(target).click();
  flushSync();
  await tick();
  slow.finish();
  await settle();

  expect(save).not.toHaveBeenCalled();
  expect(card(target).hasAttribute('data-save-ready')).toBe(true);
  expect(target.textContent).toContain(m.post_file_ready_to_save());

  downloadButton(target).click();
  flushSync();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('blob:downloaded', 'cours.pdf');
  expect(card(target).hasAttribute('data-save-ready')).toBe(false);
});

it('keeps the FIRST request: a second tap while it is fetching is ignored', async () => {
  const target = mountFile(true);
  const slow = slowDownload();
  rowButton(target).click();
  flushSync();
  await tick();
  // The reader taps the download button while the open is in flight: it does not replace it.
  downloadButton(target).click();
  rowButton(target).click();
  flushSync();
  await tick();
  slow.finish();
  await settle();

  expect(download).toHaveBeenCalledTimes(1);
  expect(viewerOpen(target)).toBe(true);
  expect(card(target).hasAttribute('data-save-ready')).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it('a failure drops the request; "Reessayer" leaves the row ready and the next tap acts at once', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = mountFile(true);
  const slow = slowDownload();
  rowButton(target).click();
  flushSync();
  await tick();
  slow.fail(new MediaUnreachableError(new TypeError('x')));
  await settle();

  expect(viewerOpen(target)).toBe(false);
  const retry = [...target.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.media_retry_button())
  )!;
  download.mockResolvedValueOnce('blob:second');
  retry.click();
  await settle();

  // The dropped request did not come back by itself: the reader taps again, and it acts now.
  expect(download).toHaveBeenCalledTimes(2);
  expect(viewerOpen(target)).toBe(false);
  rowButton(target).click();
  flushSync();
  expect(viewerOpen(target)).toBe(true);
  expect(download).toHaveBeenCalledTimes(2);
});

it('a tap beats `deferred`: the row far from the viewport still fetches when tapped', async () => {
  const target = mountFile(true, { deferred: true });
  expect(download).not.toHaveBeenCalled();
  download.mockResolvedValueOnce('blob:deferred');
  rowButton(target).click();
  await settle();
  expect(download).toHaveBeenCalledTimes(1);
  expect(viewerOpen(target)).toBe(true);
});

it('keeps the first-page preview on the full card, downloaded as before', async () => {
  download.mockResolvedValueOnce('blob:full');
  const target = mountFile(false);
  await settle();
  expect(download).toHaveBeenCalledTimes(1);
  expect(target.querySelector('[data-post-media-open]')).not.toBeNull();
});

it('the full card still saves at once, inside the tap', async () => {
  download.mockResolvedValueOnce('blob:full');
  const target = mountFile(false);
  await settle();
  downloadButton(target).click();
  flushSync();
  expect(save).toHaveBeenCalledWith('blob:full', 'cours.pdf');
});
