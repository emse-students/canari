import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostContent from './PostContent.svelte';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const media = [
  {
    type: 'image',
    mediaId: 'm-1',
    key: 'k-1',
    iv: 'i-1',
    mimeType: 'image/jpeg',
    size: 1,
    width: 1200,
    height: 800,
  },
  {
    type: 'image',
    mediaId: 'm-2',
    key: 'k-2',
    iv: 'i-2',
    mimeType: 'image/jpeg',
    size: 1,
    width: 800,
    height: 1200,
  },
  {
    type: 'image',
    mediaId: 'm-3',
    key: 'k-3',
    iv: 'i-3',
    mimeType: 'image/jpeg',
    size: 1,
    width: 1000,
    height: 1000,
  },
];

describe('PostContent gallery', () => {
  it('preserves each attachment ratio instead of forcing every photo into a square', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const post = {
      id: 'p1',
      markdown: '',
      media,
      createdAt: new Date(0).toISOString(),
    } as never;
    const app = mount(PostContent, { target, props: { post, authToken: 'tok' } });
    mounted.push(() => unmount(app));
    flushSync();

    const cells = [...target.querySelectorAll<HTMLElement>('.grid > div')];
    expect(cells).toHaveLength(3);
    expect(cells.map((cell) => cell.style.aspectRatio)).toEqual([
      '1.5 / 1',
      '0.6666666666666666 / 1',
      '1 / 1',
    ]);
  });
});
