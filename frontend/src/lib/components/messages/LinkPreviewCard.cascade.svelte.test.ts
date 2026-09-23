/**
 * A DECLARED IMAGE IS NOT A DRAWN IMAGE, AND THE CASCADE HAS TO COME BACK DOWN.
 *
 * `og:image` -> declared icon -> conventional favicon paths -> globe is the intended order. The
 * first rung used to be decided by the payload merely CARRYING an `og:image`, so a declaration that
 * 404s left an empty 64px square with a usable favicon one rung below, never reached - measured on
 * production 2026-09-23, where the declaration was itself a URL this service had built against the
 * wrong base.
 *
 * The other half is the cost: while the Open Graph image is what the card draws, the favicon chain
 * is a series of outbound requests whose answer nothing reads. Both directions are pinned here,
 * because a fix for either one alone is what the other would hide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const PAYLOAD = {
  url: 'https://events.example/e/150',
  title: 'An event',
  image: 'https://events.example/cover.jpg',
  icon: 'https://events.example/assets/icon.png',
};

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }),
}));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://canari-emse.fr' }));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: async () => {},
  previewTicket: () => 'tkt',
}));
vi.mock('$lib/utils/canariLinkPreview', () => ({ fetchCanariLinkPreview: async () => null }));

import LinkPreviewCard from './LinkPreviewCard.svelte';

/** The proxied form of a raw URL, as `proxiedPreviewImageUrl` builds it. */
const proxied = (raw: string) =>
  `https://canari-emse.fr/api/mls/link-preview/image?url=${encodeURIComponent(raw)}&t=tkt`;

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

/** Every src an off-screen probe has been pointed at, in order. */
let probed: string[] = [];
/** Which of them decode; everything else answers the way a 404 does. */
let decodes: (src: string) => boolean = () => true;

/**
 * happy-dom never loads anything, so the probe's verdict has to be supplied here. It is delivered
 * asynchronously like the real one, which is what makes the render order under test real too.
 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  set src(value: string) {
    probed.push(value);
    queueMicrotask(() => {
      if (decodes(value)) {
        this.naturalWidth = 64;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    });
  }
}

const mounted: (() => void)[] = [];

/** Mounts the card and lets it fetch, so every assertion is about a settled cascade. */
async function mountNearCard() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LinkPreviewCard, {
    target,
    props: { url: 'https://events.example/e/150' },
  });
  mounted.push(() => void unmount(component));
  flushSync();
  FakeObserver.last!.enter();
  flushSync();
  return target;
}

beforeEach(() => {
  probed = [];
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

describe('LinkPreviewCard cascades from the Open Graph image down', () => {
  it('draws the Open Graph image and probes no favicon at all when it decodes', async () => {
    const target = await mountNearCard();

    await vi.waitFor(() => {
      const img = target.querySelector('img');
      expect(img?.getAttribute('src')).toBe(proxied(PAYLOAD.image));
    });

    // THE POINT OF THE SECOND ASSERTION: the icon is already on screen, so walking the chain would
    // be outbound requests whose answer nothing reads.
    expect(probed).toEqual([proxied(PAYLOAD.image)]);
  });

  it('falls through to the site icon when the declared image does not decode', async () => {
    decodes = (src) => !src.includes(encodeURIComponent(PAYLOAD.image));

    const target = await mountNearCard();

    await vi.waitFor(() => {
      const img = target.querySelector('img');
      expect(img?.getAttribute('src')).toBe(proxied(PAYLOAD.icon!));
    });

    // Asked in order, and the declared icon is reached only because the image was refused.
    expect(probed[0]).toBe(proxied(PAYLOAD.image));
    expect(probed).toContain(proxied(PAYLOAD.icon!));
  });

  it('shows the globe rather than an empty square when nothing decodes', async () => {
    decodes = () => false;

    const target = await mountNearCard();

    await vi.waitFor(() => {
      expect(target.querySelector('img')).toBeNull();
      expect(target.querySelector('svg')).not.toBeNull();
    });
  });
});
