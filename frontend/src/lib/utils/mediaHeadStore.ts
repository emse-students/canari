/**
 * THE FIRST BYTES OF A SEGMENTED MEDIA, FETCHED AHEAD AND JOINED BY WHOEVER READS IT NEXT (owner,
 * 2026-11-11: "precharger les 2-3 medias suivants en parallele").
 *
 * The reel viewer fetches the HEAD of the pages after the one on screen (`reels/reelAhead.ts`): the
 * file's header and its first {@link MEDIA_HEAD_SEGMENTS} sealed segment(s), one ranged read. That is
 * what a first frame needs (decoded into `reelPosters`) and the start of a stream's head - not the
 * whole file, so the reel being watched keeps the link.
 *
 * WHAT MAKES IT SAFE is that both read paths JOIN these bytes instead of fetching them again - the
 * precondition the 2026-11-04 refusal named (`docs/wiki/frontend/modules/reels.md`):
 *
 * - a STREAMED video's segment feed wraps its network source in {@link headedRangeSource}: a read
 *   inside the head is answered from it, in flight or not; a read across its end fetches only the
 *   part after it;
 * - a video read WHOLE (`mediaBlobCache.ts`) takes the head and asks the server for the rest only
 *   ({@link readAfterHead}), one `Range: bytes=N-` request.
 *
 * ONE HEAD PER MEDIA, MANY HOLDERS, ABANDONED WHEN THE LAST ONE LEAVES. Every holder - the
 * look-ahead, a stream, a whole read - counts; when the count reaches zero the head leaves the map
 * and its request is ABORTED, queued (the gate drops it) or on the wire (`fetch` is given the
 * signal). A page scrolled past before its head arrived therefore leaves no fetch behind. A failure
 * is never memoised: the entry leaves the map and the next reader asks again.
 *
 * The head is fetched in the gate's BACKGROUND lane (`requestGate.ts`): it never takes the last free
 * slot, and every request for what is on screen goes before it - until the reader reaches its page:
 * a foreground reader joining a head still QUEUED raises it to the foreground lane (`GateRank`),
 * so the bytes being watched never wait behind the pages after them.
 */
import {
  SEGMENTED_MEDIA_HEADER_BYTES,
  SEGMENTED_MEDIA_SEGMENT_BYTES,
  SEGMENT_TAG_BYTES,
} from '$lib/mediaSegmented';
import { sessionLinkRate } from './linkRate';
import { GateRank, type GateLane } from './requestGate';
import { httpRangeSource, type CiphertextRangeSource } from './segmentedMediaReader';

/**
 * Segments in a head: ONE, the first frame's (1 MiB holds a fragmented MP4's `moov` and its first
 * fragment). Measured on dev before settling it (2026-11-11, a link of ~780 KiB/s, reels of ~3 MB
 * read whole): a head of TWO segments was two thirds of the file and never arrived within a 1 s
 * wheel step, so the reader met black anyway. The second segment of a paced stream's head start is
 * the stream's own first request once the page is on screen.
 */
export const MEDIA_HEAD_SEGMENTS = 1;

/** The bytes a head asks for: the header and {@link MEDIA_HEAD_SEGMENTS} default-sized segments. */
export const MEDIA_HEAD_BYTES =
  SEGMENTED_MEDIA_HEADER_BYTES +
  MEDIA_HEAD_SEGMENTS * (SEGMENTED_MEDIA_SEGMENT_BYTES + SEGMENT_TAG_BYTES);

/** Fetches `[0, MEDIA_HEAD_BYTES)` of a media - injectable for tests. */
export type HeadFetch = (
  mediaId: string,
  baseUrl: string,
  signal: AbortSignal,
  rank: GateRank
) => Promise<Uint8Array<ArrayBuffer>>;

const networkHead: HeadFetch = (mediaId, baseUrl, signal, rank) =>
  httpRangeSource(
    baseUrl,
    mediaId,
    (bytes, seconds) => sessionLinkRate.observe(bytes, seconds),
    undefined,
    rank
  ).read(0, MEDIA_HEAD_BYTES, signal);

let fetchHead: HeadFetch = networkHead;

interface HeadEntry {
  bytes: Promise<Uint8Array<ArrayBuffer>>;
  holders: number;
  controller: AbortController;
  /** Starts in the background lane; the first foreground reader to join raises it. */
  rank: GateRank;
}

const heads = new Map<string, HeadEntry>();

/** One holder's share of a head. */
export interface MediaHeadHold {
  /** The head's ciphertext - SHORTER than {@link MEDIA_HEAD_BYTES} when the file ends inside it. */
  readonly bytes: Promise<Uint8Array<ArrayBuffer>>;
  /** Gives the share back; the last one aborts a head still coming. Idempotent. */
  release(): void;
}

function holdEntry(mediaId: string, entry: HeadEntry): MediaHeadHold {
  entry.holders += 1;
  let released = false;
  return {
    bytes: entry.bytes,
    release() {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      if (heads.get(mediaId) === entry) heads.delete(mediaId);
      // Harmless on a head already in; a head still coming is dropped from the queue or the wire.
      entry.controller.abort();
    },
  };
}

/**
 * Holds the head of `mediaId`, starting its fetch when nobody holds it yet. The caller must
 * {@link MediaHeadHold.release} it.
 */
export function holdMediaHead(mediaId: string, baseUrl: string): MediaHeadHold {
  const running = heads.get(mediaId);
  if (running) return holdEntry(mediaId, running);
  const controller = new AbortController();
  const rank = new GateRank('background');
  const entry: HeadEntry = {
    bytes: fetchHead(mediaId, baseUrl, controller.signal, rank),
    holders: 0,
    controller,
    rank,
  };
  heads.set(mediaId, entry);
  entry.bytes.catch(() => {
    // Not memoised: the next reader asks again. The holder that waits on it says why.
    if (heads.get(mediaId) === entry) heads.delete(mediaId);
  });
  return holdEntry(mediaId, entry);
}

/**
 * Joins the head of `mediaId` when one is held - never starts one.
 *
 * @param lane Who joins. A `foreground` reader (the page on screen: its stream or whole read, or the
 *   preload of the next page) raises a head still QUEUED in the background lane ahead of the other
 *   pages' work (`GateRank`), because it is watching those bytes now. A head already on the wire
 *   runs on.
 */
export function joinMediaHead(
  mediaId: string,
  lane: GateLane = 'foreground'
): MediaHeadHold | null {
  const running = heads.get(mediaId);
  if (!running) return null;
  if (lane === 'foreground') running.rank.promote();
  return holdEntry(mediaId, running);
}

/** Waits for `bytes`, rejecting with the abort reason when `signal` fires first. */
function headOrAbort(
  bytes: Promise<Uint8Array<ArrayBuffer>>,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!signal) return bytes;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    bytes.then(
      (b) => {
        signal.removeEventListener('abort', onAbort);
        resolve(b);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Whether the file ends inside a head of this length: then the head IS the file. */
function headIsWholeFile(head: Uint8Array): boolean {
  return head.byteLength < MEDIA_HEAD_BYTES;
}

/**
 * A range source that answers from a held head what lies inside it, and asks `inner` only for what
 * lies after it.
 *
 * A HEAD THAT FAILED IS LEFT FOR GOOD. The feed keeps this source for its whole life, so failing
 * every read with the head's error would fail every segment of a stream whose own reads would have
 * succeeded. That read and every later one go to `inner` instead, said ONCE at warn: reaching it
 * means the head fetched ahead failed, which is the signal.
 */
export function headedRangeSource(
  head: MediaHeadHold,
  inner: CiphertextRangeSource
): CiphertextRangeSource {
  let failed = false;
  return {
    async read(start, endExclusive, signal, rank) {
      if (failed) return inner.read(start, endExclusive, signal, rank);
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await headOrAbort(head.bytes, signal);
      } catch (err) {
        // The reader's own abort is its answer, never the head's failure.
        if (signal?.aborted) throw err;
        if (!failed) {
          failed = true;
          console.warn('[media-head] the head failed - this stream reads every range itself', err);
        }
        return inner.read(start, endExclusive, signal, rank);
      }
      const len = bytes.byteLength;
      if (endExclusive <= len || headIsWholeFile(bytes)) {
        return new Uint8Array(bytes.slice(start, Math.min(endExclusive, len)));
      }
      if (start >= len) return inner.read(start, endExclusive, signal, rank);
      const rest = await inner.read(len, endExclusive, signal, rank);
      const out = new Uint8Array(len - start + rest.byteLength);
      out.set(bytes.subarray(start), 0);
      out.set(rest, len - start);
      return out;
    },
  };
}

/**
 * The whole ciphertext of a media whose head is held: the head, then ONE request for the rest.
 *
 * @param head The held head.
 * @param fetchFrom Asks the server for bytes `[from, end)`: answers `206` with them, `416` when the
 *   file ends exactly at `from`, or `200` with the whole file when the server ignored the range.
 * @param fetchWhole Asks for the whole file, with no range. A failed head, or a `206` that does not
 *   start where the head ends, is answered with this instead: joining that body to the head would
 *   build a file that never decrypts.
 * @param signal Abandons the wait for the head.
 */
export async function readAfterHead(
  head: MediaHeadHold,
  fetchFrom: (from: number) => Promise<Response>,
  fetchWhole: () => Promise<Response>,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await headOrAbort(head.bytes, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[media-head] the head failed - the whole file is read instead', err);
    return (await fetchWhole()).arrayBuffer();
  }
  if (headIsWholeFile(bytes)) return bytes.slice().buffer;
  const from = bytes.byteLength;
  const res = await fetchFrom(from);
  if (res.status === 416) return bytes.slice().buffer;
  if (res.status === 200) {
    // The server ignored the range: its body is the whole file, so it is correct - only the head's
    // bytes were fetched twice. A server that does not serve ranges is refused elsewhere
    // (`MediaRangeUnsupportedError`), so this is said loudly.
    console.warn('[media-head] the rest was asked as a range and answered whole (200)');
    return res.arrayBuffer();
  }
  const range = res.headers.get('Content-Range');
  if (rangeStartOf(range) !== from) {
    console.warn(
      `[media-head] the rest was asked from byte ${from} and answered "${range ?? 'no Content-Range'}" - the whole file is read instead`
    );
    await res.body?.cancel();
    return (await fetchWhole()).arrayBuffer();
  }
  const rest = new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(from + rest.byteLength);
  out.set(bytes, 0);
  out.set(rest, from);
  return out.buffer;
}

/** The first byte a `Content-Range: bytes A-B/N` names, or `null` when it names none. */
function rangeStartOf(contentRange: string | null): number | null {
  const match = /^bytes (\d+)-/.exec(contentRange ?? '');
  return match ? Number(match[1]) : null;
}

/** How many heads are held now - the look-ahead's report and the tests. */
export function heldMediaHeadCount(): number {
  return heads.size;
}

/** Test seam: replaces the network fetch (`null` restores it) and forgets every head. */
export function setHeadFetchForTest(fetcher: HeadFetch | null): void {
  fetchHead = fetcher ?? networkHead;
  heads.clear();
}
