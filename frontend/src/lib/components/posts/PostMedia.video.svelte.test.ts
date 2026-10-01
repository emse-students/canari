/**
 * A POST'S VIDEO IS PLAYED BY CANARI'S PLAYER, NEVER BY THE ENGINE'S `controls` (user, 2026-10-01).
 *
 * The feed's inline video was already the app's (`InlineVideo`); the gallery viewer and the
 * single-media viewer still handed the clip to a `<video controls>`, which drew Android's grey bar
 * on the Mi 9T. Pinned: no `<video>` this component draws carries `controls`, the viewers carry
 * `VideoPlayer`'s group, and the box before the bytes arrive is Canari's poster, not a black box.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn(() => null),
  releaseDecryptedMediaBlobUrl: vi.fn(),
}));
const download = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));

import PostMedia from './PostMedia.svelte';

const VIDEO = {
  type: 'video' as const,
  mediaId: 'v1',
  key: 'k',
  iv: 'iv',
  mimeType: 'video/mp4',
  size: 1,
};
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mountVideo(props: Record<string, unknown>, resolved = true) {
  download.mockImplementation(() =>
    resolved ? Promise.resolve('blob:clip') : new Promise<string>(() => {})
  );
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostMedia, {
    target,
    props: { media: VIDEO, authToken: 'token', ...props },
  });
  mounted.push(() => unmount(component));
  flushSync();
  await tick();
  await tick();
  flushSync();
  return target;
}

const player = () =>
  document.querySelector(`[role="group"][aria-label="${m.video_player_label()}"]`);

describe("PostMedia - a video is Canari's to play", () => {
  it('the gallery viewer plays it in VideoPlayer, with no native controls', async () => {
    const target = await mountVideo({ galleryMode: true });
    expect(player()).not.toBeNull();
    const video = target.querySelector('video')!;
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.getAttribute('src')).toBe('blob:clip');
  });

  it('the single-media viewer opened from the feed does too', async () => {
    const target = await mountVideo({});
    expect(player()).toBeNull();
    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.post_fullscreen_label()}"]`)!
      .click();
    flushSync();
    expect(player()).not.toBeNull();
    for (const video of document.querySelectorAll('video')) {
      expect(video.hasAttribute('controls')).toBe(false);
    }
  });

  it("shows Canari's poster while the bytes are on their way", async () => {
    const target = await mountVideo({}, false);
    expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).not.toBeNull();
    expect(target.querySelector('video')).toBeNull();
  });
});
