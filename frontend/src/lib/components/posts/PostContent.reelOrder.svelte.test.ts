// @vitest-environment happy-dom
/**
 * A FEED VIDEO OPENED FULL SCREEN GOES ON IN THE READER'S ORDER, WITH THE SWITCH (owner, 2026-11-11):
 * the stream after it is asked in the order last chosen on the device ("Pour toi" or "Récents",
 * `reelOrder.ts`), and the viewer draws the switch - the CanaReels entry's own implementation
 * (`reels/reelStream.svelte.ts`). With "Défilement infini des CanaReels" off there is no list after
 * the post, so there is nothing to order and no switch. The viewer is a stand-in; the real viewer's
 * swap from a feed opening is `ReelViewer.order.svelte.test.ts`'s.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostContent from './PostContent.svelte';
import type { PostEntity } from '$lib/posts/api';
import { settings } from '$lib/stores/settingsStore.svelte';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('./ReelViewerStub.test-helper.svelte')).default,
}));
const listPosts = vi.fn((_options: unknown) => Promise.resolve([] as PostEntity[]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));

const video = { type: 'video', mediaId: 'm-1', key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 };
const mounted: (() => void)[] = [];

beforeEach(() => {
  listPosts.mockReset().mockResolvedValue([{ id: 'other' }] as PostEntity[]);
  settings.setReelsOrder('ranked');
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  settings.setInfiniteReelsEnabled(true);
  settings.setReelsOrder('ranked');
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function openFeedVideo() {
  const target = document.body.appendChild(document.createElement('div'));
  const post = {
    id: 'opened',
    kind: 'post',
    markdown: '',
    media: [video],
    createdAt: new Date(0).toISOString(),
  } as never;
  const app = mount(PostContent, { target, props: { post, authToken: 'tok' } });
  mounted.push(() => void unmount(app));
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
  await settle();
  return document.querySelector<HTMLElement>('[data-reel-viewer-stub]')!;
}

/** The `ranked` flag of every list read so far. */
const rankedAsked = () => listPosts.mock.calls.map(([o]) => (o as { ranked?: boolean }).ranked);

it('continues in the order the reader last chose, and draws the switch on it', async () => {
  settings.setReelsOrder('recent');
  const viewer = await openFeedVideo();
  expect(viewer.getAttribute('data-reel-viewer-stub')).toBe('opened');
  expect(viewer.getAttribute('data-order')).toBe('recent');
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-load-first]')!.click();
  await settle();
  expect(rankedAsked(), 'the stream after the video is asked newest first').toEqual([false]);
});

it('a reader who never chose continues in Pour toi', async () => {
  const viewer = await openFeedVideo();
  expect(viewer.getAttribute('data-order')).toBe('ranked');
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-load-first]')!.click();
  await settle();
  expect(rankedAsked()).toEqual([true]);
});

it('a change of order is read and remembered, and the opened post stays the start', async () => {
  const viewer = await openFeedVideo();
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-recent]')!.click();
  await settle();
  const after = document.querySelector<HTMLElement>('[data-reel-viewer-stub]')!;
  expect(after.getAttribute('data-order')).toBe('recent');
  expect(after.getAttribute('data-reel-viewer-stub')).toBe('opened');
  expect(rankedAsked()).toEqual([false]);
  expect(settings.reelsOrder).toBe('recent');
});

it('with infinite CanaReels off: no list after the post, so no switch and no read', async () => {
  settings.setInfiniteReelsEnabled(false);
  const viewer = await openFeedVideo();
  expect(viewer.hasAttribute('data-order')).toBe(false);
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-load-first]')!.click();
  await settle();
  expect(listPosts).not.toHaveBeenCalled();
});

it('a change still being read when the card closes and reopens is dropped: the new opening keeps its order', async () => {
  const viewer = await openFeedVideo();
  let answer!: (rows: PostEntity[]) => void;
  listPosts.mockImplementationOnce(() => new Promise<PostEntity[]>((r) => (answer = r)));
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-recent]')!.click();
  await settle();
  viewer.querySelector<HTMLButtonElement>('[data-reel-viewer-close]')!.click();
  await settle();
  expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
  // Reopened at once, on the same card.
  document.querySelector<HTMLButtonElement>('[data-post-media-open]')!.click();
  await settle();

  answer([{ id: 'late' }] as PostEntity[]);
  await settle();
  const again = document.querySelector<HTMLElement>('[data-reel-viewer-stub]')!;
  expect(again.getAttribute('data-order'), 'the late answer reorders nothing').toBe('ranked');
  expect(settings.reelsOrder, 'nor is its order remembered').toBe('ranked');
  again.querySelector<HTMLButtonElement>('[data-reel-viewer-load-first]')!.click();
  await settle();
  expect(rankedAsked(), 'the reopened viewer reads in Pour toi').toEqual([false, true]);
});
