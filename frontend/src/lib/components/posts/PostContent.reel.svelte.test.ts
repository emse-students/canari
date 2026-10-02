/**
 * A CanaReel in the feed is a VERTICAL 9:16 box and touching it opens the reel viewer; a post's video
 * keeps the ordinary attachment box. The media layer and the viewer are stand-ins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostContent from './PostContent.svelte';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('./ReelViewerStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const video = { type: 'video', mediaId: 'm-1', key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 };

async function render(kind: 'reel' | 'post') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = {
    id: 'p1',
    kind,
    markdown: '',
    media: [video],
    createdAt: new Date(0).toISOString(),
  } as never;
  const app = mount(PostContent, { target, props: { post, authToken: 'tok' } });
  mounted.push(() => void unmount(app));
  flushSync();
  await tick();
  flushSync();
  return target;
}

describe('PostContent, a reel', () => {
  it('is drawn in a vertical box, and a touch opens the reel viewer', async () => {
    const target = await render('reel');
    const card = target.querySelector('[data-reel-card]')!;
    expect(card.className).toContain('aspect-9/16');
    expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
    target.querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
    flushSync();
    expect(
      document.querySelector('[data-reel-viewer-stub]')?.getAttribute('data-reel-viewer-stub')
    ).toBe('p1');
  });

  it('a post with a video keeps the ordinary attachment box', async () => {
    const target = await render('post');
    expect(target.querySelector('[data-reel-card]')).toBeNull();
  });
});
