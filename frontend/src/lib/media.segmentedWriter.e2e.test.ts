/**
 * THE WRITER FLIP, RUN END TO END BEFORE ANYONE FLIPS IT.
 *
 * `SEGMENTED_MEDIA_WRITER_ENABLED` is `false` and stays so until the user raises `minClientVersion`
 * to the reader's release (`mediaSegmentedWriterFlag.ts`). This file replaces THAT ONE MODULE - the
 * exact change the flip will be - and drives the production code from a prepared video to a played
 * one:
 *
 *   prepared file (fMP4, codecs named) -> MediaService.encryptAndUpload (segmented, ref declares it)
 *   -> a media service that stores the blob and answers ranges with 206
 *   -> the transport a chat message carries the ref in (proto `MediaMsg.encoding`)
 *   -> chooseSegmentedPlayback picks the stream -> the ranged reader plays segment by segment, and
 *      a SEEK reads only the segment it lands in
 *   -> the whole-blob reader (lightbox, download) reads the same blob
 *   -> and a reader OLDER than the format cannot, which is why the flip waits for minClientVersion.
 *
 * The video bytes are a stand-in: no test engine has WebCodecs, and what the encoder makes was read
 * on the phones (docs/wiki/frontend/video-preparation.md). What matters here is every byte of them
 * coming back, in order, from each reader.
 */
import { vi } from 'vitest';

vi.mock('$lib/mediaSegmentedWriterFlag', () => ({ SEGMENTED_MEDIA_WRITER_ENABLED: true }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/utils/mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

const { MediaService } = await import('$lib/media');
const {
  SEGMENTED_MEDIA_ENCODING,
  SEGMENTED_MEDIA_SEGMENT_BYTES,
  SEGMENTED_MEDIA_WRITER_ENABLED,
  segmentedCiphertextLength,
  writesSegmented,
} = await import('$lib/mediaSegmented');
const { decryptMediaBuffer } = await import('$lib/mediaCrypto');
const { httpRangeSource, openSegmentedMedia } = await import('$lib/utils/segmentedMediaReader');
const { chooseSegmentedPlayback } = await import('$lib/utils/segmentedMediaStream');
const { acquireDecryptedMediaBlobUrl, releaseDecryptedMediaBlobUrl } =
  await import('$lib/utils/mediaBlobCache');
const {
  decodeAppMessage,
  encodeAppMessage,
  mediaEncodingFromProto,
  mediaEncodingProtoField,
  mkMedia,
} = await import('$lib/proto/codec');

const BASE = 'https://media.test';
const MIME = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
const SERVER_MAX_BYTES = 50 * 1024 * 1024;

/**
 * A segment and a part of bytes that differ from one position to the next - two segments at the
 * production segment size, the least that has a seek past the first.
 */
const PLAIN = (() => {
  const n = SEGMENTED_MEDIA_SEGMENT_BYTES + 300_000;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 131 + (i >> 16)) & 0xff;
  return bytes;
})();

/**
 * The media service, as far as a client can tell: it stores what is uploaded under an id, answers
 * `/limits`, and serves a `Range` with `206` and the slice (`416` past the end), as
 * `media.controller.ts` does.
 */
/**
 * A response carrying `bytes` - the members the client reads, and nothing slower: happy-dom's own
 * `Response` copies a megabyte in about a second, which is the whole cost of this file otherwise.
 */
function answer(status: number, bytes: Uint8Array | string): Response {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    arrayBuffer: async () => body.slice().buffer,
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    text: async () => new TextDecoder().decode(body),
  } as unknown as Response;
}

function mediaServiceFake() {
  const stored = new Map<string, Uint8Array>();
  const ranges: [number, number][] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/api/media/limits`) {
      return answer(200, JSON.stringify({ maxBytes: SERVER_MAX_BYTES }));
    }
    if (url === `${BASE}/api/media/upload`) {
      const body = init?.body as FormData;
      const blob = body.get('file') as Blob;
      const id = `m${stored.size + 1}`;
      stored.set(id, new Uint8Array(await blob.arrayBuffer()));
      return answer(201, JSON.stringify({ mediaId: id }));
    }
    const id = decodeURIComponent(url.slice(`${BASE}/api/media/`.length));
    const blob = stored.get(id);
    if (!blob) return answer(404, '');
    const range = new Headers(init?.headers).get('Range');
    if (!range) return answer(200, blob);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(a);
    const end = Math.min(Number(b), blob.byteLength - 1);
    if (start >= blob.byteLength) return answer(416, '');
    ranges.push([start, end + 1]);
    return answer(206, blob.slice(start, end + 1));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { stored, ranges };
}

/**
 * Byte equality as ONE assertion. `toEqual` on a megabyte typed array compares index by index
 * through the matcher and costs seconds; a mismatch is still named by its first differing offset.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength);
  const first = actual.findIndex((b, i) => b !== expected[i]);
  expect(first).toBe(-1);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('with the writer ON, a prepared video goes up segmented and comes back from every reader', () => {
  it('is the flag the flip changes, and nothing else', () => {
    expect(SEGMENTED_MEDIA_WRITER_ENABLED).toBe(true);
    expect(writesSegmented(MIME)).toBe(true);
    // Pictures stay single-block even then: the push thumbnail and the link preview read them.
    expect(writesSegmented('image/webp')).toBe(false);
  });

  it('runs the whole path', async () => {
    const server = mediaServiceFake();
    const service = new MediaService(BASE);

    // The ceiling a member is compared against now leaves room for the header and every tag.
    const limits = (await service.uploadLimits())!;
    expect(segmentedCiphertextLength(limits.maxPlaintextBytes)).toBeLessThanOrEqual(
      SERVER_MAX_BYTES
    );

    // 1. Upload, as `preparePostMedia` hands it over.
    const file = new File([PLAIN], 'clip.mp4', { type: MIME });
    const ref = await service.encryptAndUpload(
      file,
      'token',
      { width: 720, height: 1280 },
      'archive'
    );
    expect(ref).toMatchObject({
      type: 'video',
      encoding: SEGMENTED_MEDIA_ENCODING,
      mimeType: MIME,
      width: 720,
      height: 1280,
    });
    const stored = server.stored.get(ref.mediaId)!;
    expect(stored.byteLength).toBe(segmentedCiphertextLength(PLAIN.byteLength));

    // 2. The ref crosses the chat transport with its encoding intact.
    const wire = decodeAppMessage(
      encodeAppMessage(
        mkMedia({
          mediaId: ref.mediaId,
          mimeType: ref.mimeType,
          size: ref.size,
          ...mediaEncodingProtoField(ref.encoding),
        })
      )
    );
    expect(mediaEncodingFromProto(wire?.media?.encoding)).toBe(SEGMENTED_MEDIA_ENCODING);

    // 3. The player chooses the stream from facts alone.
    const playback = chooseSegmentedPlayback(ref, {
      MediaSource: { isTypeSupported: (t: string) => t === MIME } as never,
    });
    expect(playback.kind).toBe('stream');

    // 4. Played segment by segment through ranges, every one answered 206.
    const reader = await openSegmentedMedia(httpRangeSource(BASE, ref.mediaId), ref.key, ref.iv);
    expect(reader.segmentCount).toBe(2);
    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < reader.segmentCount; i++) {
      parts.push(await reader.readSegment(i));
    }
    expectSameBytes(new Uint8Array(await new Blob(parts).arrayBuffer()), PLAIN);

    // 5. A seek reads the one segment it lands in, and nothing before it.
    server.ranges.length = 0;
    const offset = SEGMENTED_MEDIA_SEGMENT_BYTES + 12345;
    const target = reader.segmentForOffset(offset);
    expect(target).toBe(1);
    const segment = new Uint8Array(await reader.readSegment(target));
    expectSameBytes(segment, PLAIN.slice(SEGMENTED_MEDIA_SEGMENT_BYTES));
    expect(server.ranges).toHaveLength(1);

    // 6. The whole-blob reader (lightbox, download, a picture) reads the very same blob.
    const made: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      made.push(b as Blob);
      return `blob:test/${made.length}`;
    });
    await acquireDecryptedMediaBlobUrl(ref, BASE);
    expectSameBytes(new Uint8Array(await made[0].arrayBuffer()), PLAIN);
    releaseDecryptedMediaBlobUrl(ref);

    // 7. And a reader OLDER than the format - one GCM over the whole blob - cannot: the reason the
    //    flip waits for minClientVersion.
    await expect(decryptMediaBuffer(stored.slice().buffer, ref.key, ref.iv)).rejects.toThrow();
  });
});
