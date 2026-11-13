// @vitest-environment happy-dom
/**
 * A FEED VIDEO THAT STREAMS IS PACED, AND GIVES EVERYTHING BACK WHEN ITS CARD LEAVES THE BAND
 * (reels audit, 2026-10-11: every reel scrolled near was downloaded whole and kept its decoder).
 *
 * Pinned: the feed opens the stream PACED and hands it the inline `<video>`; the viewer
 * forks it (its own element, the same segments); a card deferred again closes the stream (its segment in flight aborted) and unmounts the
 * `<video>`; coming back opens a new one; and a deferred video takes no warm blob.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FEED_STREAM_PACING, VIEWER_STREAM_PACING } from '$lib/utils/segmentedMediaStream';
import { m } from '$lib/paraglide/messages';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn<() => string | null>(() => null),
  releaseDecryptedMediaBlobUrl: vi.fn(),
  adoptDecryptedMediaBlob: vi.fn(() => 'blob:whole'),
}));

/** Every stream opened, with what it was asked to do. */
const streams = vi.hoisted(
  () =>
    [] as Array<{
      pacing: unknown;
      attached: unknown[];
      closed: boolean;
      fetchAll: ReturnType<typeof vi.fn>;
      fork: ReturnType<typeof vi.fn>;
      forks: Array<{ attached: unknown[]; closed: boolean }>;
    }>
);

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/utils/segmentedMediaStream', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/utils/segmentedMediaStream')>();
  return {
    ...original,
    chooseSegmentedPlayback: () => ({ kind: 'stream', MediaSourceCtor: class {}, managed: false }),
    openSegmentedStream: (_ref: unknown, _base: string, _playback: unknown, pacing?: unknown) => {
      const forks: Array<{ attached: unknown[]; closed: boolean }> = [];
      const record = {
        pacing,
        attached: [] as unknown[],
        closed: false,
        fetchAll: vi.fn(),
        forks,
        fork: vi.fn(() => {
          const fork = { attached: [] as unknown[], closed: false };
          forks.push(fork);
          return {
            url: `blob:viewer-${forks.length}`,
            done: new Promise<Blob>(() => {}),
            attach: (el: unknown) => {
              fork.attached.push(el);
              return () => {};
            },
            fetchAll: vi.fn(),
            fork: vi.fn(),
            close: () => (fork.closed = true),
          };
        }),
      };
      streams.push(record);
      return {
        url: `blob:mse-${streams.length}`,
        done: new Promise<Blob>(() => {}),
        attach: (el: unknown) => {
          record.attached.push(el);
          return () => {};
        },
        fetchAll: record.fetchAll,
        fork: record.fork,
        close: () => (record.closed = true),
      };
    },
  };
});

import PostMedia from './PostMedia.svelte';

const REEL = {
  type: 'video' as const,
  mediaId: 'r1',
  key: 'k',
  iv: 'iv',
  mimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
  size: 30_000_000,
  encoding: 'segmented-v1',
};
const mounted: (() => void)[] = [];

beforeEach(() => {
  streams.length = 0;
  cache.retainWarmDecryptedMediaBlobUrl.mockReturnValue(null);
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

async function settle() {
  flushSync();
  await tick();
  await tick();
  flushSync();
}

describe('PostMedia - a streamed feed video', () => {
  it('is paced and handed its inline <video>; deferred again, it closes and unmounts; back, it reopens', async () => {
    const props = $state({ media: REEL, authToken: 'token', letterbox: true, deferred: false });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, { target, props });
    mounted.push(() => unmount(component));
    await settle();

    expect(streams).toHaveLength(1);
    expect(streams[0].pacing).toEqual(FEED_STREAM_PACING);
    const video = target.querySelector('video');
    expect(video).not.toBeNull();
    expect(streams[0].attached).toEqual([video]);

    props.deferred = true;
    await settle();
    expect(streams[0].closed).toBe(true);
    expect(target.querySelector('video')).toBeNull();

    props.deferred = false;
    await settle();
    expect(streams).toHaveLength(2);
    expect(streams[1].closed).toBe(false);
    expect(target.querySelector('video')).not.toBeNull();
  });

  /**
   * THE FEED'S ANSWER REPLACES THE STORED COPY WITH NEW OBJECTS CARRYING THE SAME MEDIA (Mi 9T,
   * v1.2.9-alpha.3): the stream reopened on the same `<video>` and its `play()` was interrupted.
   */
  it('an equal media in a new object keeps its stream; a different media opens a new one', async () => {
    const props = $state({ media: REEL, authToken: 'token', letterbox: true, deferred: false });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, { target, props });
    mounted.push(() => unmount(component));
    await settle();
    expect(streams).toHaveLength(1);

    props.media = { ...REEL };
    await settle();
    expect(streams).toHaveLength(1);
    expect(streams[0].closed).toBe(false);

    props.media = { ...REEL, mediaId: 'r2' };
    await settle();
    expect(streams).toHaveLength(2);
    expect(streams[0].closed).toBe(true);
  });

  /**
   * THE TAP OF THE REVIEW (#1744): the viewer waited for the whole file, which a paced stream builds
   * only at the end - so a tap did nothing, then the viewer popped up unasked. It opens AT THE TAP
   * on a FORK of the card's stream (its own element, the same segments, never the whole-file wait),
   * and goes away with the card if the card leaves.
   */
  it('a tap opens the viewer at once on a fork of the stream, and leaving closes it', async () => {
    const props = $state({ media: REEL, authToken: 'token', letterbox: true, deferred: false });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, { target, props });
    mounted.push(() => unmount(component));
    await settle();
    const dialog = () => document.querySelector('[role="dialog"]');
    expect(dialog()).toBeNull();

    // The feed card has no expand button: its tap opens the viewer, and Enter on the focused card
    // (which carries the label) is the keyboard twin.
    target
      .querySelector<HTMLElement>(
        `[data-video-player="feed"][aria-label="${m.post_fullscreen_label()}"]`
      )!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(dialog()).not.toBeNull();
    // A fork over the card's feed, never the pacing lifted and the whole file awaited.
    expect(streams[0].fork).toHaveBeenCalledTimes(1);
    expect(streams[0].fetchAll).not.toHaveBeenCalled();
    // The viewer's `<video>` plays the FORK's URL and is handed to it, so it starts on its head.
    const viewerVideo = document.querySelector<HTMLVideoElement>('[role="dialog"] video');
    expect(viewerVideo?.getAttribute('src')).toBe('blob:viewer-1');
    expect(streams[0].forks[0].attached).toContain(viewerVideo);
    expect(streams[0].forks[0].closed).toBe(false);

    props.deferred = true;
    await settle();
    expect(dialog()).toBeNull();
    expect(streams[0].forks[0].closed).toBe(true);
  });

  it('takes no warm blob while deferred: a card outside the band holds no decoder', async () => {
    cache.retainWarmDecryptedMediaBlobUrl.mockReturnValue('blob:warm');
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, {
      target,
      props: { media: REEL, authToken: 'token', letterbox: true, deferred: true },
    });
    mounted.push(() => unmount(component));
    await settle();

    expect(cache.retainWarmDecryptedMediaBlobUrl).not.toHaveBeenCalled();
    expect(target.querySelector('video')).toBeNull();
    expect(streams).toHaveLength(0);
  });

  it('opens the gallery viewer stream paced further ahead: it never waits for the whole file', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, {
      target,
      props: { media: REEL, authToken: 'token', galleryMode: true },
    });
    mounted.push(() => unmount(component));
    await settle();

    expect(streams).toHaveLength(1);
    expect(streams[0].pacing).toBe(VIEWER_STREAM_PACING);
  });
});
