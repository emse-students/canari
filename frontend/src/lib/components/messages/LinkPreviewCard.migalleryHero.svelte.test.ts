// @vitest-environment happy-dom
/**
 * A MIGALLERY HERO CARD DRAWS THE WIDE COVER, AND KEEPS THE SQUARE ONLY WHEN IT HAS NO WIDE ONE.
 *
 * The hero banner is about 640 CSS px wide; the 400x400 square cover that suits the tile was being
 * stretched about three times across it (owner, 2026-11-26: "visibly pixelated"). The server hands
 * the site's own 1200x630 cover in the payload's `image` for every album, private included; a payload
 * read from the page rather than MiGallery's API may carry an empty one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const URL_ALBUM = `https://gallery.mitv.fr/albums/${ID}`;
const SQUARE = `https://gallery.mitv.fr/api/albums/${ID}/cover`;
const WIDE = `https://gallery.mitv.fr/api/albums/${ID}/og-cover`;

let payloadImage = WIDE;

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: async () =>
    new Response(JSON.stringify({ url: URL_ALBUM, title: 'Gala', image: payloadImage }), {
      status: 200,
    }),
}));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://canari.emse.fr' }));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: async () => {},
  previewTicket: () => 'tkt',
}));
vi.mock('$lib/utils/canariLinkPreview', () => ({ fetchCanariLinkPreview: async () => null }));

import LinkPreviewCard from './LinkPreviewCard.svelte';

const proxied = (raw: string) =>
  `https://canari.emse.fr/api/mls/link-preview/image?url=${encodeURIComponent(raw)}&t=tkt`;

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

let decodes: (src: string) => boolean = () => true;
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  set src(value: string) {
    queueMicrotask(() => {
      if (decodes(value)) {
        this.naturalWidth = 64;
        this.onload?.();
      } else this.onerror?.();
    });
  }
}

const mounted: (() => void)[] = [];

async function mountHero() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LinkPreviewCard, { target, props: { url: URL_ALBUM, hero: true } });
  mounted.push(() => void unmount(component));
  flushSync();
  FakeObserver.last!.enter();
  flushSync();
  return target;
}

/** The banner is the one `<img>` with the 1.91:1 box. */
const banner = (target: HTMLElement) =>
  target.querySelector('img[class*="aspect-[1.91/1]"]') as HTMLImageElement | null;

beforeEach(() => {
  payloadImage = WIDE;
  decodes = () => true;
  FakeObserver.last = null;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('Image', FakeImage);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('LinkPreviewCard hero, MiGallery album', () => {
  it('draws the wide 1200x630 cover in the banner', async () => {
    const target = await mountHero();
    await vi.waitFor(() => expect(banner(target)?.getAttribute('src')).toBe(proxied(WIDE)));
  });

  it('keeps the square cover when the payload carries no wide one', async () => {
    payloadImage = '';
    const target = await mountHero();
    await vi.waitFor(() => expect(banner(target)?.getAttribute('src')).toBe(proxied(SQUARE)));
  });

  it('falls back to the square cover when the wide one does not decode', async () => {
    decodes = (src) => !src.includes(encodeURIComponent(WIDE));
    const target = await mountHero();
    await vi.waitFor(() => expect(banner(target)?.getAttribute('src')).toBe(proxied(SQUARE)));
  });
});
