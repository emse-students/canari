// @vitest-environment happy-dom
/**
 * The shared-media grid thumbnail of a video draws the house glass play triangle (owner,
 * 2026-11-11), not a small Lucide `Play` on a dark wash.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import SharedMediaThumb from './SharedMediaThumb.svelte';
import type { MediaRef } from '$lib/media';

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy({}, { get: (_t, key) => () => String(key) }),
}));
vi.mock('$lib/media', () => ({
  MediaService: class {
    downloadAndDecrypt() {
      return Promise.resolve('blob:video-thumb');
    }
  },
}));
vi.mock('$lib/utils/mediaBlobCache', () => ({ releaseDecryptedMediaBlobUrl: vi.fn() }));
// No IntersectionObserver in happy-dom: the tile is "near" at once.
vi.mock('$lib/actions/nearViewport', () => ({
  nearViewport: (_node: HTMLElement, o: { onnear: () => void }) => {
    o.onnear();
    return {};
  },
}));

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('SharedMediaThumb play glyph', () => {
  it('draws the glass triangle over a video and no Lucide play icon', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(SharedMediaThumb, {
        target,
        props: { media: { mediaId: 'm1', type: 'video' } as MediaRef, authToken: 't' },
      })
    );
    flushSync();
    await tick();
    await Promise.resolve();
    flushSync();
    expect(target.querySelector('video')).not.toBeNull();
    expect(target.querySelector('[data-video-glass-glyph="play"]')).not.toBeNull();
    expect(target.querySelector('.lucide-play')).toBeNull();
  });
});
