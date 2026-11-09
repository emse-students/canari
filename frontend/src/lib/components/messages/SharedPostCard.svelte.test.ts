// @vitest-environment happy-dom
/**
 * THE SHARED-POST BUBBLE, state by state: loading, image, video, reel, text-only, unavailable - and
 * the rule that only a card that came near the viewport asks the server anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const getPost = vi.fn();
const navigateInAppFromHref = vi.fn(async (_url: string) => {});

vi.mock('$lib/posts/api', () => ({
  getPost: (id: string) => getPost(id),
  isReel: (p: { kind?: string }) => p.kind === 'reel',
}));
vi.mock('$lib/utils/appLinkNavigation', () => ({
  navigateInAppFromHref: (url: string) => navigateInAppFromHref(url),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'token' }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/components/posts/PostAuthorAvatar.svelte', async () => ({
  default: (await import('./PostAuthorAvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('../posts/ReelViewerStub.test-helper.svelte')).default,
}));

import SharedPostCard from './SharedPostCard.svelte';
import { clearSharedPostPreviews } from '$lib/posts/sharedPostPreview';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

let near = true;
/** Says "near" at once - or never, to prove a far card stays quiet. */
class Observer {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe() {
    if (near)
      this.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
  }
  disconnect() {}
}

const mounted: (() => void)[] = [];
const P1 = '11111111-1111-4111-8111-111111111111';
const URL_P = `https://canari.emse.fr/posts/${P1}`;

function render(url = URL_P): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SharedPostCard, { target, props: { url } });
  mounted.push(() => void unmount(component));
  flushSync();
  return target;
}

async function settled(target: HTMLElement, state: string) {
  await vi.waitFor(() =>
    expect(target.querySelector(`[data-shared-post="${state}"]`)).not.toBeNull()
  );
}

function tap(target: HTMLElement) {
  target
    .querySelector('a')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

const base = { id: P1, markdown: 'La **soirée** de rentrée', authorFirstName: 'Ada', media: [] };

beforeEach(() => {
  near = true;
  getPost.mockReset();
  navigateInAppFromHref.mockClear();
  clearSharedPostPreviews();
  vi.stubGlobal('IntersectionObserver', Observer);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SharedPostCard', () => {
  it('draws a skeleton while the post is being read', async () => {
    getPost.mockReturnValue(new Promise(() => {}));
    const target = render();
    await vi.waitFor(() => expect(getPost).toHaveBeenCalled());
    expect(target.querySelector('[data-shared-post="loading"]')).not.toBeNull();
    expect(target.querySelector('[data-shared-post-skeleton]')).not.toBeNull();
  });

  it('asks nothing until the card comes near the viewport', async () => {
    near = false;
    getPost.mockResolvedValue(base);
    const target = render();
    await Promise.resolve();
    expect(getPost).not.toHaveBeenCalled();
    expect(target.querySelector('[data-shared-post="loading"]')).not.toBeNull();
  });

  it('draws the author, the picture and the caption of an image post, and opens its page', async () => {
    getPost.mockResolvedValue({
      ...base,
      media: [{ type: 'image', mediaId: 'img-1', width: 1000, height: 1000 }],
    });
    const target = render();
    await settled(target, 'post');
    await vi.waitFor(() =>
      expect(target.querySelector('[data-post-media-stub="img-1"]')).not.toBeNull()
    );
    expect(target.textContent).toContain('Ada');
    expect(target.textContent).toContain('La soirée de rentrée');
    expect(target.querySelector('[data-video-play-disc]')).toBeNull();
    tap(target);
    await vi.waitFor(() => expect(navigateInAppFromHref).toHaveBeenCalledWith(URL_P));
  });

  it('draws a video post as a poster with the glass play disc, no download', async () => {
    getPost.mockResolvedValue({
      ...base,
      media: [{ type: 'video', mediaId: 'vid-1', width: 1920, height: 1080 }],
    });
    const target = render();
    await settled(target, 'post');
    expect(target.querySelector('[data-shared-post-media="video"]')).not.toBeNull();
    const disc = target.querySelector('[data-video-play-disc]')!;
    expect(disc.tagName).toBe('SPAN');
    expect(disc.getAttribute('aria-hidden')).toBe('true');
    expect(target.querySelector('[data-post-media-stub="vid-1"]')).toBeNull();
  });

  it('draws a reel as the tall card and opens the reels viewer on tap', async () => {
    getPost.mockResolvedValue({
      ...base,
      kind: 'reel',
      media: [{ type: 'video', mediaId: 'r-1', width: 1080, height: 1920 }],
    });
    const target = render();
    await settled(target, 'reel');
    const box = target.querySelector('[data-shared-post-media]') as HTMLElement;
    expect(box.getAttribute('style')).toContain('aspect-ratio: 0.5625');
    tap(target);
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-reel-viewer-stub="${P1}"]`)).not.toBeNull()
    );
    expect(navigateInAppFromHref).not.toHaveBeenCalled();
  });

  it('draws a text-only post with no media box', async () => {
    getPost.mockResolvedValue(base);
    const target = render();
    await settled(target, 'post');
    expect(target.querySelector('[data-shared-post-media]')).toBeNull();
    expect(target.textContent).toContain('La soirée de rentrée');
  });

  it('draws "Publication indisponible" for a refused post and shows nothing of it', async () => {
    getPost.mockRejectedValue(new ApiRefusalError(404, null, 'gone'));
    const target = render();
    await settled(target, 'unavailable');
    expect(target.textContent).toContain('Publication indisponible');
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('a')).toBeNull();
  });

  it('draws a read that got no answer as a link to the post, never as "indisponible"', async () => {
    getPost.mockRejectedValue(new TypeError('offline'));
    const target = render();
    await settled(target, 'failed');
    expect(target.textContent).not.toContain('Publication indisponible');
    expect(target.querySelector('[data-shared-post-skeleton]')).toBeNull();
    tap(target);
    await vi.waitFor(() => expect(navigateInAppFromHref).toHaveBeenCalledWith(URL_P));
  });

  it('turns unavailable when the picture reports an expired file', async () => {
    getPost.mockResolvedValue({
      ...base,
      media: [{ type: 'image', mediaId: 'img-9', width: 10, height: 10 }],
    });
    const target = render();
    await vi.waitFor(() => expect(target.querySelector('[data-fail-expired]')).not.toBeNull());
    (target.querySelector('[data-fail-expired]') as HTMLElement).click();
    await settled(target, 'unavailable');
  });

  it('drops the picture but keeps the text when it fails for another reason', async () => {
    getPost.mockResolvedValue({
      ...base,
      media: [{ type: 'image', mediaId: 'img-8', width: 10, height: 10 }],
    });
    const target = render();
    await vi.waitFor(() => expect(target.querySelector('[data-fail-other]')).not.toBeNull());
    (target.querySelector('[data-fail-other]') as HTMLElement).click();
    await vi.waitFor(() => expect(target.querySelector('[data-shared-post-media]')).toBeNull());
    expect(target.textContent).toContain('La soirée de rentrée');
  });
});
