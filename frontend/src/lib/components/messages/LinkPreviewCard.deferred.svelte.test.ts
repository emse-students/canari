/**
 * A CARD NOBODY HAS SCROLLED TO MUST NOT COST A REQUEST.
 *
 * The metadata fetch fired from an effect on render, so a feed of link posts opened one
 * `/api/mls/link-preview` per card during the cold start - every one of them for a card below the
 * fold, competing with the boot for the same connection. What is pinned here is the rule, not the
 * distance: the request happens on the edge from "not near" to "near", once, and never on mount.
 *
 * The observer is stubbed rather than driven, because happy-dom has no viewport to scroll: the
 * action's own contract is covered in `nearViewport.test.ts` and what this file asserts is that the
 * CARD is wired to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const apiFetch = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
const fetchCanariLinkPreview = vi.fn(async (_url: string) => null);

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (url: string) => apiFetch(url) }));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://canari-emse.fr' }));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: async () => {},
  previewTicket: () => '',
}));
vi.mock('$lib/utils/canariLinkPreview', () => ({
  fetchCanariLinkPreview: (url: string) => fetchCanariLinkPreview(url),
}));

import LinkPreviewCard from './LinkPreviewCard.svelte';

/** Keeps the registered callback reachable, which is the only way to say "it came near" here. */
class FakeObserver {
  static last: FakeObserver | null = null;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this;
  }
  observe() {}
  disconnect() {}
  enter() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const mounted: (() => void)[] = [];

function mountCard(url: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LinkPreviewCard, { target, props: { url } });
  mounted.push(() => void unmount(component));
  flushSync();
  return target;
}

beforeEach(() => {
  apiFetch.mockClear();
  fetchCanariLinkPreview.mockClear();
  FakeObserver.last = null;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('LinkPreviewCard defers its fetch', () => {
  it('asks for nothing while the card is nowhere near the viewport', () => {
    mountCard('https://example.com/an-article');

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('asks once the card comes near', async () => {
    mountCard('https://example.com/an-article');

    FakeObserver.last!.enter();
    flushSync();
    await Promise.resolve();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('holds an in-app link back the same way', async () => {
    mountCard('https://canari-emse.fr/posts/abc');

    expect(fetchCanariLinkPreview).not.toHaveBeenCalled();

    FakeObserver.last!.enter();
    flushSync();
    await Promise.resolve();

    expect(fetchCanariLinkPreview).toHaveBeenCalledTimes(1);
  });

  it('shows the pending skeleton before it has even asked, not an empty card', () => {
    const target = mountCard('https://example.com/an-article');

    expect(target.querySelector('.animate-pulse')).not.toBeNull();
  });
});
