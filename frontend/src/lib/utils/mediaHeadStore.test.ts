/**
 * A HEAD FETCHED AHEAD IS JOINED, NEVER FETCHED AGAIN (owner, 2026-11-11) - the precondition the
 * 2026-11-04 refusal of a parallel preload named (`docs/wiki/frontend/modules/reels.md`). Counted in
 * requests: the streamed path and the whole read each ask the server for nothing the head holds,
 * and a head nobody holds any more leaves no request behind.
 */
import { vi } from 'vitest';
import { encryptSegmentedMedia, SEGMENTED_MEDIA_SEGMENT_BYTES } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import type { MediaSourceConstructor } from './segmentedMediaStream';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const { openSegmentedStream } = await import('./segmentedMediaStream');
const { acquireDecryptedMediaBlobUrl, releaseDecryptedMediaBlobUrl } =
  await import('./mediaBlobCache');
const { holdMediaHead, joinMediaHead, heldMediaHeadCount, MEDIA_HEAD_BYTES, setHeadFetchForTest } =
  await import('./mediaHeadStore');

const WEBM = 'video/webm;codecs=vp9,opus';

class FakeSourceBuffer extends EventTarget {
  appendBuffer() {
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported = () => true;
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }
  addSourceBuffer() {
    return new FakeSourceBuffer();
  }
  endOfStream() {
    this.readyState = 'ended';
  }
}

const STREAM = {
  kind: 'stream' as const,
  MediaSourceCtor: FakeMediaSource as unknown as MediaSourceConstructor,
  managed: false,
};

/** A segmented video of `segments` default segments plus a tail, served by range; every ask logged. */
async function served(mediaId: string, segments: number) {
  const n = segments * SEGMENTED_MEDIA_SEGMENT_BYTES + 7;
  const plain = new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
  const { ciphertext, keyHex, ivHex } = await encryptSegmentedMedia(plain.buffer);
  const sealed = new Uint8Array(ciphertext);
  const asked: string[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const range = (init.headers as Record<string, string>).Range ?? 'whole';
      asked.push(range);
      if (init.signal) signals.push(init.signal);
      if (range === 'whole') return Promise.resolve(new Response(sealed, { status: 200 }));
      const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range)!;
      const end = b ? Math.min(Number(b) + 1, sealed.byteLength) : sealed.byteLength;
      if (Number(a) >= sealed.byteLength)
        return Promise.resolve(new Response(null, { status: 416 }));
      return Promise.resolve(new Response(sealed.slice(Number(a), end), { status: 206 }));
    })
  );
  const ref: MediaRef = {
    type: 'video',
    mediaId,
    key: keyHex,
    iv: ivHex,
    mimeType: WEBM,
    size: n,
    encoding: 'segmented-v1',
  };
  return { ref, plain, asked, signals, sealed };
}

beforeEach(() => {
  vi.stubGlobal('caches', undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  setHeadFetchForTest(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setHeadFetchForTest(null);
});

it('a stream joins the head fetched ahead: its first segments cost no second request', async () => {
  const { ref, plain, asked } = await served('v-stream', 3);
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  await head.bytes;
  expect(asked).toEqual([`bytes=0-${MEDIA_HEAD_BYTES - 1}`]);

  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const stream = openSegmentedStream(ref, 'https://media.test', STREAM);
  const whole = await stream.done;

  expect(Buffer.from(await whole.arrayBuffer()).equals(Buffer.from(plain))).toBe(true);
  // The header and segment 0 came from the head; only segments 1 to 3 were asked for.
  expect(asked.slice(1)).toHaveLength(3);
  for (const r of asked.slice(1)) {
    expect(Number(/bytes=(\d+)-/.exec(r)![1])).toBeGreaterThanOrEqual(MEDIA_HEAD_BYTES);
  }
  stream.close();
  head.release();
  expect(heldMediaHeadCount()).toBe(0);
});

it('a stream opened while the head is still on the wire waits for it instead of asking again', async () => {
  const { ref, asked, sealed } = await served('v-inflight', 2);
  let answer: (b: Uint8Array<ArrayBuffer>) => void = () => {};
  setHeadFetchForTest(() => new Promise((resolve) => (answer = resolve)));
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const stream = openSegmentedStream(ref, 'https://media.test', STREAM);
  // The page the reader passed is let go: the stream's own hold keeps the head alive.
  head.release();
  await Promise.resolve();
  expect(asked).toEqual([]);

  answer(sealed.slice(0, MEDIA_HEAD_BYTES));
  await stream.done;
  // A file of two segments and a tail: segment 1 and the tail lie past the head.
  expect(asked).toHaveLength(2);
  stream.close();
});

it('a whole read joins the head and asks only for the rest, as one range', async () => {
  const { ref, asked } = await served('v-whole', 3);
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  await head.bytes;
  await acquireDecryptedMediaBlobUrl(ref, 'https://media.test');
  expect(asked).toEqual([`bytes=0-${MEDIA_HEAD_BYTES - 1}`, `bytes=${MEDIA_HEAD_BYTES}-`]);
  releaseDecryptedMediaBlobUrl(ref);
  head.release();
});

it('a file shorter than a head is whole once its head is in: no second request', async () => {
  const { ref, asked } = await served('v-short', 1);
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  await head.bytes;
  await acquireDecryptedMediaBlobUrl(ref, 'https://media.test');
  expect(asked).toHaveLength(2);
  releaseDecryptedMediaBlobUrl(ref);
  head.release();
});

it('the last holder leaving aborts a head still coming, and nothing joins it after', async () => {
  const { ref } = await served('v-passed', 3);
  // A link that answers nothing: the request stays on the wire until it is aborted.
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          signals.push(init.signal!);
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })
    )
  );
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  head.release();
  expect(signals[0].aborted).toBe(true);
  expect(joinMediaHead(ref.mediaId)).toBeNull();
  await expect(head.bytes).rejects.toBeDefined();
});

it('a failed head is not memoised: the next reader starts afresh', async () => {
  let calls = 0;
  setHeadFetchForTest(() => {
    calls++;
    return Promise.reject(new Error('down'));
  });
  const first = holdMediaHead('v-fail', 'https://media.test');
  await expect(first.bytes).rejects.toThrow('down');
  expect(joinMediaHead('v-fail')).toBeNull();
  const second = holdMediaHead('v-fail', 'https://media.test');
  await expect(second.bytes).rejects.toThrow('down');
  expect(calls).toBe(2);
  first.release();
  second.release();
});
