// @vitest-environment happy-dom
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

async function render(kind: 'reel' | 'post', size: { width?: number; height?: number } = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = {
    id: 'p1',
    kind,
    markdown: '',
    media: [{ ...video, ...size }],
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
  it('without dimensions is drawn 9:16 under the ceiling, and a touch opens the reel viewer', async () => {
    const target = await render('reel');
    const card = target.querySelector<HTMLElement>('[data-reel-card]')!;
    expect(card.style.aspectRatio).toBe(`${9 / 16} / 1`);
    expect(card.style.maxHeight).toContain('--media-max-height');
    expect(card.className).not.toContain('h-[70svh]');
    expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
    target.querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
    flushSync();
    expect(
      document.querySelector('[data-reel-viewer-stub]')?.getAttribute('data-reel-viewer-stub')
    ).toBe('p1');
  });

  it("a reel with dimensions takes the clip's own ratio, like any video", async () => {
    const target = await render('reel', { width: 1920, height: 1080 });
    const card = target.querySelector<HTMLElement>('[data-reel-card]')!;
    expect(card.style.aspectRatio).toBe(`${1920 / 1080} / 1`);
  });

  it('a post with a video keeps the ordinary box, at 4:3 without dimensions', async () => {
    const target = await render('post');
    expect(target.querySelector('[data-reel-card]')).toBeNull();
    const box = target.querySelector<HTMLElement>('[data-video-box]')!;
    expect(box.style.aspectRatio).toBe(`${4 / 3} / 1`);
  });

  it('a portrait clip keeps its ratio and the ceiling, so the box is capped and not cropped', async () => {
    const target = await render('post', { width: 1080, height: 1920 });
    const box = target.querySelector<HTMLElement>('[data-video-box]')!;
    expect(box.style.aspectRatio).toBe(`${1080 / 1920} / 1`);
    expect(box.style.maxHeight).toContain('--media-max-height');
    expect(box.className).toContain('w-full');
    expect(box.className).toContain('bg-cn-surface');
  });

  it('a landscape clip is the same box at its own ratio', async () => {
    const target = await render('post', { width: 1920, height: 1080 });
    const box = target.querySelector<HTMLElement>('[data-video-box]')!;
    expect(box.style.aspectRatio).toBe(`${1920 / 1080} / 1`);
  });

  it("the card carries no deletion countdown: the 30 days are known, the age is the header's", async () => {
    const target = await render('reel');
    expect(target.querySelector('[data-reel-expiry]')).toBeNull();
    expect(target.querySelector('[data-reel-card]')?.textContent ?? '').not.toMatch(/\d+\s*j\b/);
  });
});
