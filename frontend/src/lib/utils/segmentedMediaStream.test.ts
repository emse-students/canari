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
import { readMp4Duration } from './mp4Duration';
import { fragmentedMp4 } from './mp4Fixture.test-helper';
import { GateRank, mediaRequestGate } from './requestGate';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const {
  chooseSegmentedPlayback,
  openSegmentedStream,
  FEED_STREAM_PACING,
  VIEWER_STREAM_PACING,
  streamProgressOf,
  streamSeekFloor,
} = await import('./segmentedMediaStream');

const WEBM = 'video/webm;codecs=vp9,opus';
const MP4 = 'video/mp4; codecs="avc1.42c01e"';
/** A request's byte range. */
const RANGE = /bytes=(\d+)-(\d+)/;

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
    // The progress a reel view's outcome line reads: nothing known before the header is read.
    const progress = streamProgressOf('blob:stream')!;
    expect(progress).toEqual({ segmentCount: null, appended: 0, bytes: 0, trimmedBefore: 0 });

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
    expect(progress).toEqual({ segmentCount: 3, appended: 3, bytes: n, trimmedBefore: 0 });
    handle.close();
    // A closed stream owns no URL; the object a caller kept still says where it got to.
    expect(streamProgressOf('blob:stream')).toBeUndefined();
    expect(progress.appended).toBe(3);
  });

  /**
   * A STREAM CAN BE SOUGHT IN BEFORE IT IS WHOLE (owner, 2026-11-10: "on ne peut plus avancer"): the
   * sender's declared length is set on the source as it opens, before any buffer exists - otherwise
   * a file whose header declares none reads `Infinity` until its last segment.
   */
  it('sets the declared duration on the source before its first buffer, and nothing when undeclared', async () => {
    const plain = new Uint8Array(10).map((_, i) => i);
    const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(plain.buffer);
    const sealed = new Uint8Array(ciphertext);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
        return Promise.resolve(
          new Response(sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength)), {
            status: 206,
          })
        );
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:declared');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const seen: { duration: number; buffers: number }[] = [];
    class DurationSource extends FakeMediaSource {
      buffers = 0;
      set duration(seconds: number) {
        seen.push({ duration: seconds, buffers: this.buffers });
      }
      addSourceBuffer() {
        this.buffers += 1;
        return super.addSourceBuffer();
      }
    }
    const open = (durationMs?: number) =>
      openSegmentedStream(
        {
          type: 'video',
          mediaId: 'd1',
          key: keyHex,
          iv: ivHex,
          mimeType: WEBM,
          size: 10,
          encoding: 'segmented-v1',
          ...(durationMs ? { durationMs } : {}),
        },
        'https://media.test',
        {
          kind: 'stream',
          MediaSourceCtor: DurationSource as unknown as MediaSourceConstructor,
          managed: false,
        }
      );
    await open(42_000).done;
    expect(seen).toEqual([{ duration: 42, buffers: 0 }]);
    await open().done;
    expect(seen, 'undeclared: the file header answers').toHaveLength(1);
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

  /**
   * THE VIEWER NEVER WAITS FOR THE WHOLE FILE, AND NEVER DOWNLOADS IT TWICE (owner, 2026-11-09: 26 s
   * before the viewer of a 33 MB video played, the card already playing). The viewer is a fork: its
   * own MediaSource over the card's segment feed.
   */
  it('a viewer fork starts on its head before the last segment, and the file is fetched once', async () => {
    const { ref, requests } = await servedVideo(8);
    const card = openSegmentedStream(ref('v'), 'https://media.test', STREAM, FEED_STREAM_PACING);
    card.attach(new FakeElement());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const cardSource = FakeMediaSource.last!;

    const viewer = card.fork();
    const viewerSource = FakeMediaSource.last!;
    expect(viewerSource).not.toBe(cardSource);
    expect(viewer.url).toBe('blob:stream');
    const element = new FakeElement();
    viewer.attach(element);

    // Its head is appended from what the card already fetched: no request, and 2 of 8 segments.
    await vi.waitFor(() => expect(viewerSource.buffer.appended).toHaveLength(2));
    await settle();
    expect(requests).toHaveLength(2);
    expect(viewerSource.buffer.appended).toHaveLength(2);
    expect(viewerSource.ended).toBeNull();

    // Playing with a full buffer ahead: it holds - the viewer never runs to the end on its own.
    element.paused = false;
    element.bufferedEnd = 60;
    element.dispatchEvent(new Event('play'));
    await settle();
    expect(requests).toHaveLength(2);
    expect(viewerSource.buffer.appended).toHaveLength(2);

    // The buffer runs low: it asks for more, and the card's feed serves it.
    element.bufferedEnd = 0;
    element.dispatchEvent(new Event('timeupdate'));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(2));

    // Closing the viewer leaves the card alone; reading to the end fetches each segment ONCE.
    viewer.close();
    expect(cardSource.readyState).toBe('open');
    const second = card.fork();
    second.fetchAll();
    const blob = await second.done;
    expect(blob.size).toBe(8 * SEGMENTED_MEDIA_SEGMENT_BYTES);
    expect(requests).toHaveLength(8);
    card.close();
  });

  it('closing the card stops a fork it fed', async () => {
    const { ref } = await servedVideo(8);
    const card = openSegmentedStream(ref('v'), 'https://media.test', STREAM, FEED_STREAM_PACING);
    const viewer = card.fork();
    viewer.attach(new FakeElement());
    const failed = viewer.done.then(
      () => 'resolved',
      (e: Error) => e.name
    );
    await settle();
    card.close();
    expect(await failed).toBe('AbortError');
  });

  it('a seek on a PAUSED element is a demand: the viewer fills the gap without a press on play', async () => {
    const { ref, requests } = await servedVideo(8);
    const viewer = openSegmentedStream(
      ref('v'),
      'https://media.test',
      STREAM,
      VIEWER_STREAM_PACING
    );
    const element = Object.assign(new FakeElement(), { seeking: false });
    viewer.attach(element);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await settle();
    expect(requests).toHaveLength(2);

    // Paused and seeking past the buffer: segments come, still in order, until the data is in.
    element.seeking = true;
    element.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(2));
    viewer.close();
  });

  it('a full buffer is trimmed behind the playhead and the segment appended again, once', async () => {
    const { ref } = await servedVideo(3);
    const card = openSegmentedStream(ref('v'), 'https://media.test', STREAM, VIEWER_STREAM_PACING);
    const buffer = FakeMediaSource.last!.buffer as FakeSourceBuffer & {
      remove?: (a: number, b: number) => void;
    };
    const removed: Array<[number, number]> = [];
    buffer.remove = (a, b) => removed.push([a, b]);
    let appends = 0;
    const real = buffer.appendBuffer.bind(buffer);
    buffer.appendBuffer = (bytes: ArrayBuffer) => {
      appends++;
      if (appends === 2) throw new DOMException('full', 'QuotaExceededError');
      real(bytes);
    };
    const element = new FakeElement();
    element.currentTime = 42;
    element.paused = false;
    element.bufferedEnd = 5;
    card.attach(element);
    const blob = await card.done;
    expect(removed).toEqual([[0, 32]]);
    // The cut is REPORTED: a seek before it would wait for a segment that never comes again.
    expect(streamProgressOf(card.url)?.trimmedBefore).toBe(32);
    // Three segments, the second appended twice (the first refusal, then the retry).
    expect(appends).toBe(4);
    expect(blob.size).toBe(3 * SEGMENTED_MEDIA_SEGMENT_BYTES);
    card.close();
  });

  /**
   * A SEEK BEFORE WHAT A STREAM STILL HOLDS STALLS FOR EVER (review of #3311): segments go in once,
   * so the floor is the later of the stream's own cut and the start of what the element buffers.
   */
  it.each([
    ['nothing cut, nothing evicted', 0, [], 0],
    ['the stream cut at 32 s', 32, [[30, 50]], 32],
    ['the engine evicted up to 12 s', 0, [[12, 40]], 12],
    ['a whole file (no stream)', undefined, [[0, 40]], 0],
  ] as const)('the seek floor when %s', (_name, cut, ranges, floor) => {
    const buffered = {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
    };
    expect(streamSeekFloor(cut === undefined ? undefined : { trimmedBefore: cut }, buffered)).toBe(
      floor
    );
  });

  /**
   * THE WHOLE FILE IS BUILT FROM THE SEGMENT BLOBS, AND ONLY ITS HEAD IS COPIED (review of #3311:
   * reading every segment back into one array held 2-3x a 35 MB reel in the heap). The `mvhd` in
   * the first segment gets the length the stream played; every other byte is the segments' own.
   */
  it('patches only the head of a finished MP4 stream, with the length the source measured', async () => {
    const movie = await fragmentedMp4(90);
    // A trailing `free` box makes the file span two segments, so the tail is a separate part.
    const pad = SEGMENTED_MEDIA_SEGMENT_BYTES;
    const plain = new Uint8Array(movie.byteLength + pad);
    plain.set(movie);
    new DataView(plain.buffer).setUint32(movie.byteLength, pad);
    plain.set([0x66, 0x72, 0x65, 0x65], movie.byteLength + 4);
    const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(plain.buffer);
    const sealed = new Uint8Array(ciphertext);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
        const part = sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength));
        return Promise.resolve(new Response(part, { status: 206 }));
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mp4');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    /** The engine's measure after `endOfStream`: the end of what was appended. */
    class MeasuredSource extends FakeMediaSource {
      duration = Infinity;
      endOfStream(error?: string) {
        super.endOfStream(error);
        this.duration = 3;
      }
    }
    const handle = openSegmentedStream(
      {
        type: 'video',
        mediaId: 'mp4',
        key: keyHex,
        iv: ivHex,
        mimeType: 'video/mp4; codecs="avc1.42c01e"',
        size: plain.byteLength,
        encoding: 'segmented-v1',
      },
      'https://media.test',
      {
        kind: 'stream',
        MediaSourceCtor: MeasuredSource as unknown as MediaSourceConstructor,
        managed: false,
      }
    );
    const whole = new Uint8Array(await (await handle.done).arrayBuffer());
    expect(readMp4Duration(plain).declaredSeconds, 'the source file: undeclared').toBe(0);
    expect(readMp4Duration(whole).declaredSeconds).toBeCloseTo(3, 3);
    // Only the duration field differs: four bytes of a v0 mvhd, nothing else moved.
    expect(whole.byteLength).toBe(plain.byteLength);
    const differing = whole.reduce((n, byte, i) => n + (byte === plain[i] ? 0 : 1), 0);
    expect(differing).toBeGreaterThan(0);
    expect(differing).toBeLessThanOrEqual(4);
    expect(String(info.mock.calls[0][0])).toContain('written into its head');
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
  /**
   * AN UNDECLARED MP4, STREAMED, LEARNS ITS LENGTH FROM ITS TAIL (owner, 2026-11-11: a CanaReel drew
   * no seek line - `the engine knows no duration (Infinity, stream)`). The muxer's 10 s clip with a
   * `free` box after its `moov` (its `tfra` offsets moved by as much), so the head holds the `moov`
   * and the fragments and the `mfra` sit at the END. `mfraAt`, when given, is the absolute offset
   * the `mfra` is moved to: on a segment boundary, the last fragment is in the segment before.
   */
  async function undeclaredMp4(
    mediaId: string,
    opts: { mfraAt?: number; hangFromRequest?: number } = {}
  ) {
    const movie = await fragmentedMp4(300);
    const at = (type: string) => {
      const code = Array.from(type, (c) => c.charCodeAt(0));
      for (let i = 4; i + 4 <= movie.length; i++) {
        if (code.every((c, k) => movie[i + k] === c)) return i - 4;
      }
      return -1;
    };
    const firstMoof = at('moof');
    const pad = opts.mfraAt ? opts.mfraAt - at('mfra') : 3 * SEGMENTED_MEDIA_SEGMENT_BYTES;
    const plain = new Uint8Array(movie.byteLength + pad);
    plain.set(movie.subarray(0, firstMoof));
    const view = new DataView(plain.buffer);
    view.setUint32(firstMoof, pad);
    plain.set([0x66, 0x72, 0x65, 0x65], firstMoof + 4);
    plain.set(movie.subarray(firstMoof), firstMoof + pad);
    // Every tfra moof_offset moves by the pad: entries of time and offset, then three small numbers.
    const tfra = at('tfra') + pad;
    const wide = plain[tfra + 8] === 1;
    const sizes = view.getUint32(tfra + 16);
    const count = view.getUint32(tfra + 20);
    const stride =
      (wide ? 16 : 8) + ((sizes >> 4) & 3) + 1 + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1);
    for (let k = 0; k < count; k++) {
      const offsetAt = tfra + 24 + k * stride + (wide ? 8 : 4);
      if (wide) view.setBigUint64(offsetAt, view.getBigUint64(offsetAt) + BigInt(pad));
      else view.setUint32(offsetAt, view.getUint32(offsetAt) + pad);
    }
    expect(readMp4Duration(plain).samplesSeconds, 'the fixture is still a 10 s movie').toBeCloseTo(
      10,
      3
    );
    const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(plain.buffer);
    const sealed = new Uint8Array(ciphertext);
    /** Each request's first plaintext segment index, and its abort signal. */
    const requests: Array<{ segment: number; signal?: AbortSignal }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const [, a, b] = RANGE.exec((init.headers as Record<string, string>).Range)!;
        // 20 header bytes, then each segment and its 16-byte tag.
        const segment = Math.max(
          0,
          Math.floor((Number(a) - 20) / (SEGMENTED_MEDIA_SEGMENT_BYTES + 16))
        );
        requests.push({ segment, signal: init.signal ?? undefined });
        if (opts.hangFromRequest !== undefined && requests.length > opts.hangFromRequest) {
          return new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          );
        }
        const part = sealed.slice(Number(a), Math.min(Number(b) + 1, sealed.byteLength));
        return Promise.resolve(new Response(part, { status: 206 }));
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mp4');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const ref: MediaRef = {
      type: 'video',
      mediaId,
      key: keyHex,
      iv: ivHex,
      mimeType: MP4,
      size: plain.byteLength,
      encoding: 'segmented-v1',
    };
    return {
      ref,
      requests,
      segmentCount: Math.ceil(plain.byteLength / SEGMENTED_MEDIA_SEGMENT_BYTES),
    };
  }

  /** An engine's source: `Infinity` until told, refusing a length set mid-update (the spec's rule). */
  class LengthSource extends FakeMediaSource {
    static lastLength: LengthSource | null = null;
    sets: number[] = [];
    current = Infinity;
    updating = false;
    constructor() {
      super();
      LengthSource.lastLength = this;
      const append = this.buffer.appendBuffer.bind(this.buffer);
      this.buffer.appendBuffer = (bytes: ArrayBuffer) => {
        this.updating = true;
        append(bytes);
        queueMicrotask(() => (this.updating = false));
      };
    }
    get duration() {
      return this.current;
    }
    set duration(seconds: number) {
      if (this.updating) throw new DOMException('updating', 'InvalidStateError');
      this.sets.push(seconds);
      this.current = seconds;
    }
  }
  const LENGTH_STREAM = {
    kind: 'stream' as const,
    MediaSourceCtor: LengthSource as unknown as MediaSourceConstructor,
    managed: false,
  };

  /** A viewer element whose buffer reaches `ahead` seconds past its playhead, told so by an event. */
  function bufferAhead(element: FakeElement, ahead: number) {
    element.bufferedEnd = element.currentTime + ahead;
    element.dispatchEvent(new Event('progress'));
  }

  it('a viewer stream gives an undeclared MP4 the length read from its tail, once its buffer can spare it, in the background lane', async () => {
    const { ref, requests, segmentCount } = await undeclaredMp4('undeclared');
    const lanes: unknown[] = [];
    const run = mediaRequestGate.run.bind(mediaRequestGate);
    vi.spyOn(mediaRequestGate, 'run').mockImplementation((task, signal, lane) => {
      lanes.push(lane instanceof GateRank ? `rank:${lane.lane}` : (lane ?? 'foreground'));
      return run(task, signal, lane);
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const viewer = openSegmentedStream(
      ref,
      'https://media.test',
      LENGTH_STREAM,
      VIEWER_STREAM_PACING
    );
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    await settle();
    // The head is in, but less than the pacing's 30 s is buffered: no tail yet.
    expect(requests.map((r) => r.segment)).toEqual([0, 1]);

    bufferAhead(element, VIEWER_STREAM_PACING.aheadSeconds);
    await vi.waitFor(() => expect(source.sets).toHaveLength(1));
    expect(source.sets[0]).toBeCloseTo(10, 3);
    expect(requests.map((r) => r.segment)).toEqual([0, 1, segmentCount - 1]);
    expect(lanes.at(-1), 'the tail read waits behind what plays').toBe('rank:background');
    expect(info.mock.calls.map((c) => String(c[0])).join(' ')).toContain(
      'read from its last fragments'
    );

    // Reading on to the end takes the tail from the feed: each segment requested once.
    viewer.fetchAll();
    await viewer.done;
    expect(requests).toHaveLength(segmentCount);
    viewer.close();
  });

  it('reaches back a segment when the last fragment starts before the last segment', async () => {
    const boundary = 3 * SEGMENTED_MEDIA_SEGMENT_BYTES;
    const { ref, requests, segmentCount } = await undeclaredMp4('reach-back', { mfraAt: boundary });
    expect(segmentCount).toBe(4);
    const viewer = openSegmentedStream(
      ref,
      'https://media.test',
      LENGTH_STREAM,
      VIEWER_STREAM_PACING
    );
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    bufferAhead(element, VIEWER_STREAM_PACING.aheadSeconds);
    await vi.waitFor(() => expect(source.sets).toHaveLength(1));
    expect(source.sets[0]).toBeCloseTo(10, 3);
    // The mfra alone in the last segment, then the one before it, which holds the last fragment.
    expect(requests.map((r) => r.segment)).toEqual([0, 1, 3, 2]);
    viewer.close();
  });

  it('no tail is read while an in-order segment is still on the wire', async () => {
    // Segment 2's request never answers: the element plays on what it has, short of 30 s.
    const { ref, requests } = await undeclaredMp4('busy', { hangFromRequest: 2 });
    const viewer = openSegmentedStream(
      ref,
      'https://media.test',
      LENGTH_STREAM,
      VIEWER_STREAM_PACING
    );
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    element.paused = false;
    element.dispatchEvent(new Event('play'));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    bufferAhead(element, 5);
    await settle();
    expect(
      requests.map((r) => r.segment),
      'segment 2 outstanding, nothing more'
    ).toEqual([0, 1, 2]);
    viewer.close();
  });

  it('closing the viewer cancels a tail read on the wire, and none starts after the close', async () => {
    // The tail's request (the third) never answers.
    const { ref, requests } = await undeclaredMp4('closed', { hangFromRequest: 2 });
    const card = openSegmentedStream(ref, 'https://media.test', LENGTH_STREAM, FEED_STREAM_PACING);
    card.attach(new FakeElement());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const viewer = card.fork();
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    bufferAhead(element, VIEWER_STREAM_PACING.aheadSeconds);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const tail = requests[2];
    expect(tail.signal?.aborted).toBe(false);

    viewer.close();
    expect(tail.signal?.aborted, 'the viewer closed: its tail read is cancelled on the wire').toBe(
      true
    );
    bufferAhead(element, 60);
    await settle();
    expect(requests).toHaveLength(3);
    expect(source.sets).toEqual([]);
    card.close();
  });

  it('a feed card, which draws no line, never fetches the tail out of order', async () => {
    const { ref, requests } = await undeclaredMp4('card');
    const card = openSegmentedStream(ref, 'https://media.test', LENGTH_STREAM, FEED_STREAM_PACING);
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    card.attach(element);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    bufferAhead(element, 60);
    await settle();
    expect(requests).toHaveLength(2);
    expect(source.sets).toEqual([]);
    card.close();
  });

  it('a declared length is the answer: the tail is not read', async () => {
    const { ref, requests } = await undeclaredMp4('declared');
    const viewer = openSegmentedStream(
      { ...ref, durationMs: 10_000 },
      'https://media.test',
      LENGTH_STREAM,
      VIEWER_STREAM_PACING
    );
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    bufferAhead(element, 60);
    await settle();
    expect(requests).toHaveLength(2);
    expect(source.sets).toEqual([10]);
    viewer.close();
  });

  it('a tail it cannot read says why, as a warning, and the stream plays on', async () => {
    const { ref } = await servedVideo(4);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewer = openSegmentedStream(
      { ...ref('no-mfra'), mimeType: MP4 },
      'https://media.test',
      LENGTH_STREAM,
      VIEWER_STREAM_PACING
    );
    const source = LengthSource.lastLength!;
    const element = new FakeElement();
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    bufferAhead(element, 60);
    await vi.waitFor(() =>
      expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toContain(
        'none read from its tail - no moov in the head'
      )
    );
    expect(source.sets).toEqual([]);
    viewer.fetchAll();
    await viewer.done;
    viewer.close();
  });

  it('a seek ahead of the buffer drives the in-order fetch up to the segment holding the target', async () => {
    const { ref } = await servedVideo(8);
    const viewer = openSegmentedStream(
      ref('seek'),
      'https://media.test',
      STREAM,
      VIEWER_STREAM_PACING
    );
    const source = FakeMediaSource.last!;
    // One second a segment: the element has buffered what was appended.
    const element = Object.assign(new FakeElement(), { seeking: false });
    Object.defineProperty(element, 'bufferedEnd', { get: () => source.buffer.appended.length });
    viewer.attach(element);
    await vi.waitFor(() => expect(source.buffer.appended).toHaveLength(2));
    await settle();
    expect(source.buffer.appended).toHaveLength(2);

    element.currentTime = 6.5;
    element.seeking = true;
    element.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(source.buffer.appended.length).toBeGreaterThanOrEqual(7));
    viewer.close();
  });
});
