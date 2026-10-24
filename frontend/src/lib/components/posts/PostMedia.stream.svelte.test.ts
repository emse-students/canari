// @vitest-environment happy-dom
/**
 * A FEED VIDEO THAT STREAMS IS PACED, AND GIVES EVERYTHING BACK WHEN ITS CARD LEAVES THE BAND
 * (reels audit, 2026-10-11: every reel scrolled near was downloaded whole and kept its decoder).
 *
 * Pinned: the feed opens the stream PACED and hands it the inline `<video>`; the viewer opens it
 * unpaced; a card deferred again closes the stream (its segment in flight aborted) and unmounts the
 * `<video>`; coming back opens a new one; and a deferred video takes no warm blob.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FEED_STREAM_PACING } from '$lib/utils/segmentedMediaStream';
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
    }>
);

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/utils/segmentedMediaStream', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/utils/segmentedMediaStream')>();
  return {
    ...original,
    chooseSegmentedPlayback: () => ({ kind: 'stream', MediaSourceCtor: class {}, managed: false }),
    openSegmentedStream: (_ref: unknown, _base: string, _playback: unknown, pacing?: unknown) => {
      const record = { pacing, attached: [] as unknown[], closed: false, fetchAll: vi.fn() };
      streams.push(record);
      return {
        url: `blob:mse-${streams.length}`,
        done: new Promise<Blob>(() => {}),
        attach: (el: unknown) => {
          record.attached.push(el);
          return () => {};
        },
        fetchAll: record.fetchAll,
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
   * only at the end - so a tap did nothing, then the viewer popped up unasked. It opens AT THE TAP,
   * lifts the pacing, and goes away with the card if the card leaves.
   */
  it('a tap opens the viewer at once on a paced stream, lifts the pacing, and leaving closes it', async () => {
    const props = $state({ media: REEL, authToken: 'token', letterbox: true, deferred: false });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, { target, props });
    mounted.push(() => unmount(component));
    await settle();
    const dialog = () => document.querySelector('[role="dialog"]');
    expect(dialog()).toBeNull();

    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.post_fullscreen_label()}"]`)!
      .click();
    await settle();

    expect(dialog()).not.toBeNull();
    expect(streams[0].fetchAll).toHaveBeenCalled();

    props.deferred = true;
    await settle();
    expect(dialog()).toBeNull();
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

  it('opens the viewer stream unpaced: the reader asked for that video', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, {
      target,
      props: { media: REEL, authToken: 'token', galleryMode: true },
    });
    mounted.push(() => unmount(component));
    await settle();

    expect(streams).toHaveLength(1);
    expect(streams[0].pacing).toBeUndefined();
  });
});
