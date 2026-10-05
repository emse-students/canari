/**
 * A post of several media is a grid of SQUARE cells with a "+N" past four (user, 2026-10-05): cells
 * that kept their own shapes left blank areas in a two-column grid. Files are rows under the grid,
 * and a cell's position is its index in the viewer. The media layer and the viewer are stand-ins.
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

/** Shapes that used to make the grid ragged: landscape, portrait, square, in turn. */
const SHAPES = [
  [1200, 800],
  [800, 1200],
  [1000, 1000],
] as const;

function image(n: number, caption?: string) {
  const [width, height] = SHAPES[n % SHAPES.length];
  return {
    type: 'image',
    mediaId: `m-${n}`,
    key: `k-${n}`,
    iv: `i-${n}`,
    mimeType: 'image/jpeg',
    size: 1,
    width,
    height,
    ...(caption ? { caption } : {}),
  };
}

function images(count: number) {
  return Array.from({ length: count }, (_, n) => image(n));
}

const file = {
  type: 'file',
  mediaId: 'f-1',
  key: 'k-f',
  iv: 'i-f',
  mimeType: 'application/pdf',
  size: 1,
  fileName: 'doc.pdf',
};

const video = {
  type: 'video',
  mediaId: 'v-1',
  key: 'k-v',
  iv: 'i-v',
  mimeType: 'video/mp4',
  size: 1,
  width: 1920,
  height: 1080,
};

function render(media: unknown[]) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = { id: 'p1', markdown: '', media, createdAt: new Date(0).toISOString() } as never;
  const app = mount(PostContent, { target, props: { post, authToken: 'tok' } });
  mounted.push(() => unmount(app));
  flushSync();
  return target;
}

function cells(target: HTMLElement) {
  return [...target.querySelectorAll<HTMLElement>('[data-gallery-cell]')];
}

function openedAt(target: HTMLElement) {
  const box = target.ownerDocument.querySelector<HTMLElement>('[data-lightbox]');
  return box ? { index: box.dataset.dotIndex, count: box.dataset.dotCount } : null;
}

describe('PostContent gallery', () => {
  it('draws two media as two squares side by side, whatever their own shapes', () => {
    const target = render(images(2));
    const grid = target.querySelector<HTMLElement>('[data-post-gallery]')!;
    expect(grid.dataset.postGallery).toBe('pair');
    expect(grid.classList.contains('grid-cols-2')).toBe(true);
    expect(cells(target)).toHaveLength(2);
    for (const cell of cells(target)) {
      expect(cell.classList.contains('aspect-square')).toBe(true);
      expect(cell.style.aspectRatio).toBe('');
    }
  });

  it('draws three as one large square spanning two rows beside two stacked squares', () => {
    const target = render(images(3));
    const grid = target.querySelector<HTMLElement>('[data-post-gallery]')!;
    expect(grid.dataset.postGallery).toBe('feature');
    expect(grid.classList.contains('grid-cols-3')).toBe(true);
    const [first, ...rest] = cells(target);
    expect(first.classList.contains('col-span-2')).toBe(true);
    expect(first.classList.contains('row-span-2')).toBe(true);
    expect(rest).toHaveLength(2);
    // The spanning cell is square too, so the picture inside it can never stretch its rows.
    for (const cell of [first, ...rest])
      expect(cell.classList.contains('aspect-square')).toBe(true);
  });

  it('draws four as a 2x2 with no "+N"', () => {
    const target = render(images(4));
    expect(target.querySelector<HTMLElement>('[data-post-gallery]')!.dataset.postGallery).toBe(
      'quad'
    );
    expect(cells(target)).toHaveLength(4);
    expect(target.querySelector('[data-gallery-more]')).toBeNull();
  });

  it('draws five as a 2x2 whose fourth cell says "+1"', () => {
    const target = render(images(5));
    expect(cells(target)).toHaveLength(4);
    const more = target.querySelector<HTMLElement>('[data-gallery-more]')!;
    expect(cells(target)[3].contains(more)).toBe(true);
    expect(more.textContent?.trim()).toBe('+1');
    expect(more.getAttribute('aria-label')).toMatch(/1/);
  });

  it('draws nine as a 2x2 whose "+5" opens the viewer at the fourth media, over all nine', () => {
    const target = render(images(9));
    expect(cells(target)).toHaveLength(4);
    const more = target.querySelector<HTMLButtonElement>('[data-gallery-more]')!;
    expect(more.textContent?.trim()).toBe('+5');
    expect(more.getAttribute('aria-label')).toMatch(/5/);
    more.click();
    flushSync();
    expect(openedAt(target)).toEqual({ index: '3', count: '9' });
  });

  it('opens the viewer at the touched cell', () => {
    const target = render(images(4));
    cells(target)[2].querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
    flushSync();
    expect(openedAt(target)).toEqual({ index: '2', count: '4' });
  });

  it('draws a file as a row under the grid, never as a cell, without renumbering the pictures', () => {
    const target = render([image(0), file, image(1), image(2)]);
    expect(cells(target).map((cell) => cell.querySelector('button')!.dataset.mediaId)).toEqual([
      'm-0',
      'm-1',
      'm-2',
    ]);
    const rows = [...target.querySelectorAll<HTMLElement>('[data-gallery-document]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('button')!.dataset.mediaId).toBe('f-1');
    const grid = target.querySelector('[data-post-gallery]')!;
    expect(grid.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    cells(target)[2].querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
    flushSync();
    expect(openedAt(target)).toEqual({ index: '2', count: '3' });
  });

  it('draws a lone picture beside a file at its own shape, with no grid', () => {
    const target = render([image(1), file]);
    expect(target.querySelector('[data-post-gallery]')).toBeNull();
    expect(target.querySelector<HTMLElement>('[style*="aspect-ratio"]')!.style.aspectRatio).toBe(
      '0.6666666666666666 / 1'
    );
    expect(target.querySelectorAll('[data-gallery-document]')).toHaveLength(1);
  });

  it('asks a video cell to fill its square, and a still to keep its own crop', () => {
    const target = render([image(0), video]);
    const [still, clip] = cells(target).map((cell) => cell.querySelector('button')!);
    expect(still.dataset.letterbox).toBe('false');
    expect(clip.dataset.letterbox).toBe('true');
  });

  it('keeps the caption overlay on a cell, and hides it under the "+N"', () => {
    const media = [...images(3), image(3, 'quatrieme'), image(4)];
    media[0] = image(0, 'premiere');
    const target = render(media);
    expect(cells(target)[0].textContent).toContain('premiere');
    expect(cells(target)[3].textContent).not.toContain('quatrieme');
  });
});
