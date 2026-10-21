/**
 * Which videos stream while they download, decided from facts alone - and a stream that does.
 *
 * MSE fails HALF-WAY on a container it cannot append, so the choice must be made before a byte is
 * fetched, from what the ref and the engine already say. Each refusal reason is pinned, because the
 * one that matters most - `no-codecs`, every picked file today - is the one nobody would notice.
 */
import { vi } from 'vitest';
import { encryptSegmentedMedia, SEGMENTED_MEDIA_SEGMENT_BYTES } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import type { MediaSourceConstructor } from './segmentedMediaStream';
import { flushMacrotask } from '../../test/flush';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const { chooseSegmentedPlayback, openSegmentedStream, FEED_STREAM_PACING } =
  await import('./segmentedMediaStream');

const WEBM = 'video/webm;codecs=vp9,opus';

function ctor(supported: boolean): MediaSourceConstructor {
  return Object.assign(function FakeMediaSource() {} as unknown as MediaSourceConstructor, {
    isTypeSupported: () => supported,
  });
}

describe('chooseSegmentedPlayback', () => {
  const seg = { encoding: 'segmented-v1', type: 'video' as const, mimeType: WEBM };

  it('streams a segmented, codecs-bearing video the engine can play', () => {
    const MediaSource = ctor(true);
    expect(chooseSegmentedPlayback(seg, { MediaSource })).toEqual({
      kind: 'stream',
      MediaSourceCtor: MediaSource,
      managed: false,
    });
  });

  it("takes Safari's ManagedMediaSource when it is the only one, and says so", () => {
    const ManagedMediaSource = ctor(true);
    expect(chooseSegmentedPlayback(seg, { ManagedMediaSource })).toMatchObject({
      kind: 'stream',
      managed: true,
    });
  });

  it.each([
    ['single-block', { ...seg, encoding: undefined }, { MediaSource: ctor(true) }],
    ['not-av', { ...seg, type: 'image' as const }, { MediaSource: ctor(true) }],
    ['no-codecs', { ...seg, mimeType: 'video/mp4' }, { MediaSource: ctor(true) }],
    ['no-media-source', seg, {}],
    ['type-unsupported', seg, { MediaSource: ctor(false) }],
  ])('reads the whole blob for %s', (reason, ref, env) => {
    expect(chooseSegmentedPlayback(ref, env)).toEqual({ kind: 'blob', reason });
  });
});

/** Just enough of MSE to watch what is appended, in order. */
class FakeSourceBuffer extends EventTarget {
  appended: Uint8Array[] = [];
  appendBuffer(bytes: ArrayBuffer) {
    this.appended.push(new Uint8Array(bytes));
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}

class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | null = null;
  static isTypeSupported = () => true;
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  buffer = new FakeSourceBuffer();
  ended: string | undefined | null = null;
  constructor() {
    super();
    FakeMediaSource.last = this;
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }
  addSourceBuffer() {
    return this.buffer;
  }
  endOfStream(error?: string) {
    this.readyState = 'ended';
    this.ended = error;
  }
}

describe('openSegmentedStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('appends every verified segment in order, ends the stream, and hands back the whole file', async () => {
    // Two default-sized segments and a bit: the opening read carries segment 0, then one range each.
    const n = 2 * SEGMENTED_MEDIA_SEGMENT_BYTES + 3;
    const plain = new Uint8Array(n).map((_, i) => i & 0xff);
    const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(plain.buffer);
    const sealed = new Uint8Array(ciphertext);

    const ranges: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const range = (init.headers as Record<string, string>).Range;
        ranges.push(range);
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
        const part = sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength));
        return Promise.resolve(new Response(part, { status: 206 }));
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const ref: MediaRef = {
      type: 'video',
      mediaId: 'v1',
      key: keyHex,
      iv: ivHex,
      mimeType: WEBM,
      size: n,
      encoding: 'segmented-v1',
    };
    const handle = openSegmentedStream(ref, 'https://media.test', {
      kind: 'stream',
      MediaSourceCtor: FakeMediaSource as unknown as MediaSourceConstructor,
      managed: false,
    });
    expect(handle.url).toBe('blob:stream');

    const blob = await handle.done;
    // Byte-compared rather than deep-equalled: two megabytes element by element take seconds.
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(plain))).toBe(true);
    const appended = FakeMediaSource.last!.buffer.appended;
    expect(appended.map((a) => a.byteLength)).toEqual([
      SEGMENTED_MEDIA_SEGMENT_BYTES,
      SEGMENTED_MEDIA_SEGMENT_BYTES,
      3,
    ]);
    expect(FakeMediaSource.last!.ended).toBeUndefined();
    expect(ranges).toHaveLength(3);
    expect(ranges[0].startsWith('bytes=0-')).toBe(true);
    handle.close();
  });

  it('ends the stream as a decode error when a segment does not authenticate', async () => {
    const plain = new Uint8Array(SEGMENTED_MEDIA_SEGMENT_BYTES + 10);
    const s = await encryptSegmentedMedia(plain.buffer);
    const sealed = new Uint8Array(s.ciphertext);
    sealed[sealed.byteLength - 1] ^= 1; // the last segment's tag
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
        const part = sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength));
        return Promise.resolve(new Response(part, { status: 206 }));
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = openSegmentedStream(
      {
        type: 'video',
        mediaId: 'v2',
        key: s.keyHex,
        iv: s.ivHex,
        mimeType: WEBM,
        size: plain.byteLength,
        encoding: 'segmented-v1',
      },
      'https://media.test',
      {
        kind: 'stream',
        MediaSourceCtor: FakeMediaSource as unknown as MediaSourceConstructor,
        managed: false,
      }
    );
    const err = await handle.done.catch((e) => e);
    expect(err.fault).toBe('segment-auth');
    // Segment 0 played; the false one never reached the element.
    expect(FakeMediaSource.last!.buffer.appended).toHaveLength(1);
    await Promise.resolve();
    expect(FakeMediaSource.last!.ended).toBe('decode');
  });

  it('refuses a server that answers a range with the whole object', async () => {
    const plain = new Uint8Array(100);
    const s = await encryptSegmentedMedia(plain.buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(s.ciphertext, { status: 200 })))
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = openSegmentedStream(
      {
        type: 'video',
        mediaId: 'v3',
        key: s.keyHex,
        iv: s.ivHex,
        mimeType: WEBM,
        size: 100,
        encoding: 'segmented-v1',
      },
      'https://media.test',
      {
        kind: 'stream',
        MediaSourceCtor: FakeMediaSource as unknown as MediaSourceConstructor,
        managed: false,
      }
    );
    const err = await handle.done.catch((e) => e);
    expect(err.name).toBe('MediaRangeUnsupportedError');
  });

  /** A sealed video of `segments` default-sized segments, served by a fetch that records ranges. */
  async function servedVideo(segments: number, hangFromRequest = Infinity) {
    const n = segments * SEGMENTED_MEDIA_SEGMENT_BYTES;
    const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(new Uint8Array(n).buffer);
    const sealed = new Uint8Array(ciphertext);
    const requests: Array<{ mediaId: string; bytes: number; signal?: AbortSignal }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
        const part = sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength));
        requests.push({
          mediaId: decodeURIComponent(url.split('/').pop()!),
          bytes: part.byteLength,
          signal: init.signal ?? undefined,
        });
        if (requests.length > hangFromRequest) {
          // On the wire until aborted, as a slow link holds a segment.
          return new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          );
        }
        return Promise.resolve(new Response(part, { status: 206 }));
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const ref = (mediaId: string): MediaRef => ({
      type: 'video',
      mediaId,
      key: keyHex,
      iv: ivHex,
      mimeType: WEBM,
      size: n,
      encoding: 'segmented-v1',
    });
    return { ref, requests };
  }

  const STREAM = {
    kind: 'stream' as const,
    MediaSourceCtor: FakeMediaSource as unknown as MediaSourceConstructor,
    managed: false,
  };

  /** An element's state as a paced stream reads it: playing or not, and what it has buffered. */
  class FakeElement extends EventTarget {
    paused = true;
    currentTime = 0;
    bufferedEnd = 0;
    get buffered() {
      const end = this.bufferedEnd;
      return {
        length: end > 0 ? 1 : 0,
        start: () => 0,
        end: () => end,
      } as unknown as TimeRanges;
    }
  }

  /** Lets every pending fetch, decrypt and append settle. */
  const settle = () => flushMacrotask();

  /**
   * THE BOUND THE AUDIT FOUND MISSING (2026-10-11): nothing failed if a feed card downloaded a 35 MB
   * reel it never played. Ten paced cards that are never played fetch their HEAD and nothing else -
   * two segments each, whatever the length of the video.
   */
  it('bounds what N paced feed cards fetch to their head when none of them plays', async () => {
    const { ref, requests } = await servedVideo(8);
    const handles = Array.from({ length: 10 }, (_, i) =>
      openSegmentedStream(ref(`reel-${i}`), 'https://media.test', STREAM, FEED_STREAM_PACING)
    );
    for (const handle of handles) handle.attach(new FakeElement());
    await vi.waitFor(() => expect(requests).toHaveLength(20));
    await settle();

    expect(requests).toHaveLength(20);
    const total = requests.reduce((sum, r) => sum + r.bytes, 0);
    // Two segments a card and their tags/header: never the eight-segment file.
    expect(total).toBeLessThanOrEqual(10 * (2 * SEGMENTED_MEDIA_SEGMENT_BYTES + 1024));
    for (let i = 0; i < 10; i++) {
      expect(requests.filter((r) => r.mediaId === `reel-${i}`)).toHaveLength(2);
    }
    for (const handle of handles) handle.close();
  });

  it('fetches past the head only while its element plays and is short of buffer', async () => {
    const { ref, requests } = await servedVideo(6);
    const handle = openSegmentedStream(ref('r'), 'https://media.test', STREAM, FEED_STREAM_PACING);
    const element = new FakeElement();
    handle.attach(element);
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    // Playing with nothing ahead of the playhead: the next segment is asked for.
    element.paused = false;
    element.dispatchEvent(new Event('play'));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(2));

    // Enough buffered ahead: the stream holds.
    element.bufferedEnd = 60;
    await settle();
    const held = requests.length;
    element.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(requests).toHaveLength(held);

    // The rest on demand: `fetchAll` lifts the pacing and the whole file arrives.
    handle.fetchAll();
    const blob = await handle.done;
    expect(blob.size).toBe(6 * SEGMENTED_MEDIA_SEGMENT_BYTES);
    expect(requests).toHaveLength(6);
    handle.close();
  });

  it('stops for good when closed - the segment in flight is aborted and nothing more is asked', async () => {
    const { ref, requests } = await servedVideo(6, 2);
    const handle = openSegmentedStream(ref('r'), 'https://media.test', STREAM, FEED_STREAM_PACING);
    const element = new FakeElement();
    element.paused = false;
    handle.attach(element);
    // The third request - past the head, asked because the element plays - hangs on the wire.
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].signal?.aborted).toBe(false);

    handle.close();
    const atClose = requests.length;
    expect(requests[2].signal?.aborted).toBe(true);
    await expect(handle.done).rejects.toMatchObject({ name: 'AbortError' });
    element.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(requests).toHaveLength(atClose);
  });

  /** Safari's ManagedMediaSource says when it wants bytes; a paced stream waits for it. */
  it('holds a ManagedMediaSource stream while it is not streaming, and resumes on startstreaming', async () => {
    const { ref, requests } = await servedVideo(6);
    const handle = openSegmentedStream(
      ref('r'),
      'https://media.test',
      { ...STREAM, managed: true },
      FEED_STREAM_PACING
    );
    const source = FakeMediaSource.last as FakeMediaSource & { streaming?: boolean };
    source.streaming = false;
    const element = new FakeElement();
    element.paused = false;
    handle.attach(element);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    element.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(requests).toHaveLength(2);

    source.streaming = true;
    source.dispatchEvent(new Event('startstreaming'));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(2));
    handle.close();
  });

  it('wakes a stream waiting for demand when it is closed, so it never hangs', async () => {
    const { ref, requests } = await servedVideo(4);
    const handle = openSegmentedStream(ref('r'), 'https://media.test', STREAM, FEED_STREAM_PACING);
    handle.attach(new FakeElement());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await settle();

    handle.close();

    await expect(handle.done).rejects.toMatchObject({ name: 'AbortError' });
  });
});
