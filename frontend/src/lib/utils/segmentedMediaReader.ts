/**
 * The RANDOM-ACCESS reader of a segmented blob (`mediaSegmented.ts`): it fetches only the segments
 * it is asked for, by HTTP range, and verifies each one before handing it out.
 *
 * It is what a player streams from: segment 0 can be decrypted and played while the rest is still
 * on the server, and a seek costs the ONE segment that holds the target offset
 * ({@link SegmentedMediaReader.segmentForOffset}), never the bytes before it.
 *
 * The bytes come from a {@link CiphertextRangeSource}, so the reader does not know or care whether
 * they are on the network ({@link httpRangeSource}) or already in memory ({@link memoryRangeSource},
 * the ciphertext cache and the tests).
 */

import {
  SEGMENTED_MEDIA_HEADER_BYTES,
  SEGMENTED_MEDIA_SEGMENT_BYTES,
  SEGMENT_TAG_BYTES,
  SegmentedMediaError,
  importSegmentedKey,
  openSegment,
  parseSegmentedHeader,
  segmentCiphertextRange,
  segmentIndexForPlaintextOffset,
  type SegmentedMediaHeader,
} from '$lib/mediaSegmented';
import { getToken } from '$lib/stores/auth';
import {
  MediaDownloadError,
  MediaNotFoundError,
  MediaPurgedError,
  MediaUnreachableError,
} from './mediaErrors';
import { mediaRequestGate } from './requestGate';

/** Where a reader's ciphertext bytes come from. */
export interface CiphertextRangeSource {
  /**
   * Bytes `[start, endExclusive)` of the stored blob - FEWER when the blob ends first, as an HTTP
   * range is clamped to the object's end. The reader is what turns "fewer" into a truncation.
   */
  read(start: number, endExclusive: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * The server answered a `Range` request with the whole object (`200`) instead of the part (`206`).
 *
 * NOT a path to continue on: a reader that accepted it would download the whole file once PER
 * SEGMENT. It means the media-service (or a proxy in front of it) does not serve ranges, which the
 * writer flip requires (`SEGMENTED_MEDIA_WRITER_ENABLED`) - so the fix is there.
 */
export class MediaRangeUnsupportedError extends Error {
  constructor(readonly status: number) {
    super(`media range read answered ${status}, not 206 - the server is not serving ranges`);
    this.name = 'MediaRangeUnsupportedError';
  }
}

/**
 * Ranged reads of `/api/media/:id`, one request per call, each through `mediaRequestGate` like
 * every other media download and each with a token resolved at that moment (`getToken`), since a
 * stream outlives an access token.
 *
 * @param baseUrl The media service's base URL.
 * @param mediaId The object.
 */
export function httpRangeSource(baseUrl: string, mediaId: string): CiphertextRangeSource {
  const url = `${baseUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`;
  return {
    async read(start, endExclusive, signal) {
      // Typed exactly as the whole download types them (`fetchMediaObject`), so a renderer reads
      // one vocabulary (`mediaFailureCause`) whichever path the media took.
      const res = await mediaRequestGate.run(async () => {
        const headers = {
          Authorization: `Bearer ${await getToken()}`,
          Range: `bytes=${start}-${endExclusive - 1}`,
        };
        try {
          return await fetch(url, { headers, signal });
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new MediaUnreachableError(err);
        }
      }, signal);
      if (res.status === 410) throw new MediaPurgedError();
      if (res.status === 404) throw new MediaNotFoundError();
      // 416: the range starts past the end - the blob is shorter than its header announces.
      if (res.status === 416) return new Uint8Array(0);
      if (res.status !== 206) {
        console.error(
          `[media-seg] range ${start}-${endExclusive - 1} of ${mediaId}: ${res.status}`
        );
        if (res.ok) throw new MediaRangeUnsupportedError(res.status);
        throw new MediaDownloadError(res.status);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Ranged reads of a blob already in memory: the ciphertext cache, and the tests. */
export function memoryRangeSource(blob: ArrayBuffer | Uint8Array): CiphertextRangeSource {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  return {
    read(start, endExclusive) {
      return Promise.resolve(new Uint8Array(bytes.slice(start, endExclusive)));
    },
  };
}

/** A segmented blob opened for random access. Build one with {@link openSegmentedMedia}. */
export class SegmentedMediaReader {
  /** Bytes of segment 0 read together with the header, so opening and playing cost one request. */
  private prefetchedFirst: Uint8Array<ArrayBuffer> | null;

  constructor(
    private readonly source: CiphertextRangeSource,
    private readonly key: CryptoKey,
    private readonly iv: Uint8Array<ArrayBuffer>,
    readonly header: SegmentedMediaHeader,
    prefetchedFirst: Uint8Array<ArrayBuffer> | null
  ) {
    this.prefetchedFirst = prefetchedFirst;
  }

  /** How many segments the blob holds. */
  get segmentCount(): number {
    return this.header.segmentCount;
  }

  /** The file's size. */
  get plaintextLength(): number {
    return this.header.plaintextLength;
  }

  /** The segment holding plaintext byte `offset` - a seek reads this one segment and no other. */
  segmentForOffset(offset: number): number {
    return segmentIndexForPlaintextOffset(this.header, offset);
  }

  /**
   * Fetches and opens segment `index`.
   *
   * @throws {SegmentedMediaError} `length` when the blob ends before the segment does (truncated),
   *   `segment-auth` when its tag does not verify (altered, reordered, a false final segment).
   */
  async readSegment(index: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (index < 0 || index >= this.header.segmentCount) {
      throw new RangeError(`segment ${index} outside [0, ${this.header.segmentCount})`);
    }
    const [start, end] = segmentCiphertextRange(this.header, index);
    let sealed: Uint8Array<ArrayBuffer>;
    if (index === 0 && this.prefetchedFirst && this.prefetchedFirst.byteLength >= end - start) {
      sealed = this.prefetchedFirst.slice(0, end - start);
      this.prefetchedFirst = null;
    } else {
      sealed = await this.source.read(start, end, signal);
    }
    if (sealed.byteLength !== end - start) {
      console.error(
        `[media-seg] segment ${index}/${this.header.segmentCount}: ${sealed.byteLength} of ${end - start} bytes - truncated`
      );
      throw new SegmentedMediaError(
        'length',
        `segmented media: segment ${index} is ${sealed.byteLength} bytes where ${end - start} were announced`,
        index
      );
    }
    return openSegment(this.key, this.iv, this.header, index, sealed);
  }
}

/**
 * Opens a segmented blob: ONE ranged read for the header and, speculatively, the whole of a
 * default-sized segment 0 - so the first frame costs one round trip, not two. When the header
 * names another segment size, the prefetched bytes simply go unused.
 *
 * @throws {SegmentedMediaError} for a header this client refuses.
 */
export async function openSegmentedMedia(
  source: CiphertextRangeSource,
  keyHex: string,
  ivHex: string,
  signal?: AbortSignal
): Promise<SegmentedMediaReader> {
  const head = await source.read(
    0,
    SEGMENTED_MEDIA_HEADER_BYTES + SEGMENTED_MEDIA_SEGMENT_BYTES + SEGMENT_TAG_BYTES,
    signal
  );
  const header = parseSegmentedHeader(head);
  console.debug(
    `[media-seg] open: ${header.plaintextLength} bytes, ${header.segmentCount} segment(s) of ${header.segmentPlaintextBytes}`
  );
  const { key, iv } = await importSegmentedKey(keyHex, ivHex);
  return new SegmentedMediaReader(
    source,
    key,
    iv,
    header,
    new Uint8Array(head.slice(SEGMENTED_MEDIA_HEADER_BYTES))
  );
}
