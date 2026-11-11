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
const {
  holdMediaHead,
  joinMediaHead,
  heldMediaHeadCount,
  MEDIA_HEAD_BYTES,
  readAfterHead,
  setHeadFetchForTest,
} = await import('./mediaHeadStore');
const { GateRank } = await import('./requestGate');

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
      return Promise.resolve(
        new Response(sealed.slice(Number(a), end), {
          status: 206,
          headers: { 'Content-Range': `bytes ${a}-${end - 1}/${sealed.byteLength}` },
        })
      );
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

/**
 * A FAILED HEAD MUST NOT FAIL THE STREAM (review of #3337, F1): the feed keeps its source for its
 * whole life, so a head that rejected used to reject every later segment too.
 */
it('a stream whose head failed reads every range itself, and its fork still plays', async () => {
  const { ref, plain, asked } = await served('v-headfail', 3);
  let fail: (err: Error) => void = () => {};
  setHeadFetchForTest(() => new Promise((_, reject) => (fail = reject)));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  head.bytes.catch(() => {});
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stream');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // The stream joins the head while it is still coming; then the head fails.
  const stream = openSegmentedStream(ref, 'https://media.test', STREAM);
  const viewer = stream.fork();
  fail(new Error('head down'));

  const whole = await stream.done;
  expect(Buffer.from(await whole.arrayBuffer()).equals(Buffer.from(plain))).toBe(true);
  // Segment 0 and every later one were read by the stream itself, each once.
  expect(asked).toHaveLength(4);
  // The viewer is paced: asked for the rest, it plays the whole file from the same feed.
  viewer.fetchAll();
  const seen = await viewer.done;
  expect(seen.size).toBe(plain.byteLength);
  expect(asked, 'the fork read nothing again').toHaveLength(4);
  const said = warn.mock.calls.filter((c) => String(c[0]).includes('[media-head] the head failed'));
  expect(said, 'the fallback is said once, not per segment').toHaveLength(1);
  viewer.close();
  stream.close();
  head.release();
});

it('a whole read whose head failed reads the whole file instead', async () => {
  const { ref, asked } = await served('v-wholefail', 3);
  setHeadFetchForTest(() => Promise.reject(new Error('head down')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const head = holdMediaHead(ref.mediaId, 'https://media.test');
  head.bytes.catch(() => {});
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:whole');
  await expect(acquireDecryptedMediaBlobUrl(ref, 'https://media.test')).resolves.toBe('blob:whole');
  expect(asked).toEqual(['whole']);
  releaseDecryptedMediaBlobUrl(ref);
  head.release();
});

/** F5: a `206` is joined to the head only when it starts where the head ends. */
it('a rest that does not start where the head ends is never joined: the whole file is read', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const head = {
    bytes: Promise.resolve(new Uint8Array(MEDIA_HEAD_BYTES).fill(1)),
    release: () => {},
  };
  const whole = new Uint8Array(MEDIA_HEAD_BYTES + 10).fill(2);
  const fetchWhole = vi.fn(async () => new Response(whole, { status: 200 }));
  const shifted = async () =>
    new Response(new Uint8Array(10), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-9/${MEDIA_HEAD_BYTES + 10}` },
    });

  const out = new Uint8Array(await readAfterHead(head, shifted, fetchWhole));
  expect(fetchWhole).toHaveBeenCalledTimes(1);
  expect(Buffer.from(out).equals(Buffer.from(whole))).toBe(true);
  expect(String(warn.mock.calls[0][0])).toContain(`asked from byte ${MEDIA_HEAD_BYTES}`);

  // No Content-Range at all is not a proof either.
  const unnamed = async () => new Response(new Uint8Array(10), { status: 206 });
  await readAfterHead(head, unnamed, fetchWhole);
  expect(fetchWhole).toHaveBeenCalledTimes(2);

  // The right one is joined.
  const right = async () =>
    new Response(new Uint8Array(10).fill(3), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${MEDIA_HEAD_BYTES}-${MEDIA_HEAD_BYTES + 9}/${MEDIA_HEAD_BYTES + 10}`,
      },
    });
  const joined = new Uint8Array(await readAfterHead(head, right, fetchWhole));
  expect(fetchWhole).toHaveBeenCalledTimes(2);
  expect(joined.byteLength).toBe(MEDIA_HEAD_BYTES + 10);
  expect(joined[MEDIA_HEAD_BYTES]).toBe(3);
});

/** F2: the page the reader reaches raises its head, still queued, out of the background lane. */
it('a foreground reader joining a head raises its rank; the look-ahead does not', async () => {
  const ranks: InstanceType<typeof GateRank>[] = [];
  setHeadFetchForTest((_id, _base, _signal, rank) => {
    ranks.push(rank);
    return new Promise(() => {});
  });
  const ahead = holdMediaHead('v-rank', 'https://media.test');
  expect(ranks[0].lane).toBe('background');
  const other = joinMediaHead('v-rank', 'background');
  expect(ranks[0].lane).toBe('background');
  const reader = joinMediaHead('v-rank');
  expect(ranks[0].lane).toBe('foreground');
  reader?.release();
  other?.release();
  ahead.release();
});
