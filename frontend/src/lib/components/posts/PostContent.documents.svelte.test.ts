// @vitest-environment happy-dom
/**
 * ONE DOCUMENT IS A CARD, SEVERAL ARE A LIST OF ROWS (owner, 2026-11-02): a post of five PDFs was a
 * column of five first-page previews. A lone document keeps its preview; from two files on every
 * file is a compact row, beside a gallery or not. The media layer is a stand-in that reports whether
 * it was asked for a compact row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostContent from './PostContent.svelte';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/MediaLightbox.svelte', async () => ({
  default: (await import('./MediaLightboxStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const doc = (n: number) => ({
  type: 'file',
  mediaId: `f-${n}`,
  key: 'k',
  iv: 'i',
  mimeType: 'application/pdf',
  size: 1,
  fileName: `doc-${n}.pdf`,
});
const image = (n: number) => ({
  type: 'image',
  mediaId: `i-${n}`,
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 1,
  width: 100,
  height: 100,
});
const audio = { type: 'audio', mediaId: 'a-1', key: 'k', iv: 'i', mimeType: 'audio/mpeg', size: 1 };

function render(media: unknown[]) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = { id: 'p1', markdown: '', media, createdAt: new Date(0).toISOString() } as never;
  const app = mount(PostContent, { target, props: { post, authToken: 'tok' } });
  mounted.push(() => unmount(app));
  flushSync();
  return target;
}

/** The compact flag of each document slot, in order. */
function documentFlags(target: HTMLElement) {
  return [...target.querySelectorAll<HTMLElement>('[data-gallery-document]')].map(
    (slot) => slot.querySelector<HTMLElement>('[data-post-media-open]')!.dataset.compact
  );
}

describe('PostContent documents', () => {
  it('draws a lone document as the full card, preview included', () => {
    const target = render([doc(1)]);
    expect(target.querySelector<HTMLElement>('[data-post-media-open]')!.dataset.compact).toBe(
      'false'
    );
  });

  it('draws a lone document beside pictures as the full card', () => {
    const target = render([image(1), image(2), doc(1)]);
    expect(documentFlags(target)).toEqual(['false']);
  });

  it('draws two documents as two compact rows', () => {
    const target = render([doc(1), doc(2)]);
    expect(documentFlags(target)).toEqual(['true', 'true']);
    expect(target.querySelector('[data-post-gallery]')).toBeNull();
  });

  it('draws several documents as compact rows under an unchanged gallery', () => {
    const target = render([image(1), image(2), doc(1), doc(2), doc(3)]);
    expect(documentFlags(target)).toEqual(['true', 'true', 'true']);
    expect(target.querySelectorAll('[data-gallery-cell]')).toHaveLength(2);
  });

  it('keeps one picture whole and draws its several documents as compact rows', () => {
    const target = render([image(1), doc(1), doc(2)]);
    expect(documentFlags(target)).toEqual(['true', 'true']);
  });

  it('does not count audio as a document: a file and a recording keep the full card', () => {
    const target = render([doc(1), audio]);
    expect(documentFlags(target)).toEqual(['false', 'false']);
  });
});
