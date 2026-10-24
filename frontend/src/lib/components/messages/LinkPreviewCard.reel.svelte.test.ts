// @vitest-environment happy-dom
/**
 * A SHARED REEL'S CARD OPENS THE REEL (user, 2026-10-23, sharing lot S6): a tap on the card of a
 * reel opens the reels viewer on it; a tap on an ordinary post's card still opens its page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const fetchCanariLinkPreview = vi.fn();
const navigateInAppFromHref = vi.fn(async (_url: string) => {});

vi.mock('$lib/utils/canariLinkPreview', () => ({
  fetchCanariLinkPreview: (url: string) => fetchCanariLinkPreview(url),
}));
vi.mock('$lib/utils/appLinkNavigation', () => ({
  navigateInAppFromHref: (url: string) => navigateInAppFromHref(url),
}));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: async () => {},
  previewTicket: () => '',
}));
vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'token' }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('../posts/ReelViewerStub.test-helper.svelte')).default,
}));

import LinkPreviewCard from './LinkPreviewCard.svelte';

/** Says "the card came near" at once, so the card reads its preview. */
class NearObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  disconnect() {}
}

const mounted: (() => void)[] = [];

async function tapCard(url: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LinkPreviewCard, { target, props: { url } });
  mounted.push(() => void unmount(component));
  flushSync();
  await vi.waitFor(() => expect(fetchCanariLinkPreview).toHaveBeenCalled());
  await Promise.resolve();
  flushSync();
  target
    .querySelector('a')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  fetchCanariLinkPreview.mockReset();
  navigateInAppFromHref.mockClear();
  vi.stubGlobal('IntersectionObserver', NearObserver);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('LinkPreviewCard on a shared reel', () => {
  it("opens the reels viewer on the reel, not the post's page", async () => {
    fetchCanariLinkPreview.mockResolvedValue({
      kind: 'post',
      categoryLabel: 'Publication',
      title: 'A reel',
      reelPost: { id: 'reel-1', kind: 'reel' },
    });
    await tapCard('https://canari.emse.fr/posts/reel-1');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-reel-viewer-stub="reel-1"]')).not.toBeNull()
    );
    expect(navigateInAppFromHref).not.toHaveBeenCalled();
  });

  it("opens an ordinary post's page", async () => {
    fetchCanariLinkPreview.mockResolvedValue({
      kind: 'post',
      categoryLabel: 'Publication',
      title: 'A post',
      reelPost: null,
    });
    await tapCard('https://canari.emse.fr/posts/p1');
    await vi.waitFor(() =>
      expect(navigateInAppFromHref).toHaveBeenCalledWith('https://canari.emse.fr/posts/p1')
    );
    expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
  });
});
