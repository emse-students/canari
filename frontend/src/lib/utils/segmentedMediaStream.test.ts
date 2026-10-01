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

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const { chooseSegmentedPlayback, openSegmentedStream } = await import('./segmentedMediaStream');

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
});
