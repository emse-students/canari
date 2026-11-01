/**
 * PLAY WHILE DOWNLOADING: a segmented video fed to the `<video>` element segment by segment through
 * Media Source Extensions, each segment decrypted and verified just before it is appended.
 *
 * # When this path is taken, and why the decision is a FACT and never a try
 *
 * MSE only accepts a container it can append in pieces - WebM, or FRAGMENTED MP4 - and only with its
 * codecs named. An ordinary MP4 straight out of a phone's camera is neither fragmented nor described
 * by its `file.type` (`video/mp4`, no codecs), and appending one fails half-way. Learning that by
 * appending would be learning by failing what a fact could have told us. So the stream is chosen
 * only when ALL of these are already known before a byte is fetched ({@link chooseSegmentedPlayback}):
 *
 * - the ref is segmented (`encoding: 'segmented-v1'`) - a single-block blob cannot be played early
 *   whatever the player;
 * - its `mimeType` NAMES ITS CODECS (`video/webm;codecs=vp9,opus`, `video/mp4;codecs=avc1...`). Only a
 *   recorder writes that - `MediaRecorder.mimeType`, which R3's capture will put in the ref - and a
 *   recorder's output is appendable by construction. A picked file never carries it;
 * - the engine has `MediaSource` (Chrome, Firefox, desktop Safari, the Android WebView) or
 *   `ManagedMediaSource` (Safari 17.1+, the only one an iPhone has), and it says it can play that
 *   exact type.
 *
 * Anything else takes the whole-blob path (`mediaBlobCache`), which reads a segmented blob too - it
 * just cannot start before the end. Neither is a fallback of the other: each is the primary path for
 * the refs it is chosen for, and the choice is logged.
 *
 * # A PACED stream fetches what its element is about to play, and no more
 *
 * A feed card used to fetch EVERY segment of every reel it came near, kept them, and never stopped
 * when the card left the screen: ten reels of 28-35 MB scrolled past were ~300 MB of mobile data
 * (reels audit, 2026-10-11). A paced stream ({@link StreamPacing}) fetches the HEAD - the first
 * segments, which is what a first frame needs (2 of 20 on both phones, 2026-10-01) - and then only
 * while its attached element ({@link SegmentedStreamHandle.attach}) is PLAYING and holds less than
 * `aheadSeconds` past its playhead. A paused element - off screen (`playWhileVisible`), a viewer open
 * over it, an autoplay refused - asks for nothing. The demand is read from the element's own state
 * (`paused`, `buffered`, `currentTime`), the fact that says what it will play next, never from a
 * clock. Leaving the viewport band is the owner's to act on: it closes the stream, which aborts the
 * segment in flight (`PostMedia`, `deferred`).
 *
 * An UNPACED stream - the viewer, the lightbox - fetches the whole file as fast as it comes: the
 * reader asked for that video. {@link SegmentedStreamHandle.fetchAll} turns a paced stream into one
 * when its owner opens a viewer that waits for the whole file.
 *
 * # What is NOT here yet
 *
 * - SEEKING AHEAD of the download waits for it: segments are appended in order. The reader can fetch
 *   any one segment (`SegmentedMediaReader.segmentForOffset`), but mapping a TIME to a byte offset
 *   needs the container's index (a WebM `Cues`, an MP4 `sidx`), and that belongs with the capture
 *   that writes the container (R3).
 * - A closed stream re-fetches its head when it is opened again: the segments it had are not kept
 *   anywhere but the element it fed, which closing released.
 * - A range the ENGINE EVICTS from the buffer is not fetched again: segments go in once, in order. A
 *   `ManagedMediaSource` (iPhone) may evict under memory pressure and stall there - the pacing
 *   honours its `streaming` flag, but re-fetching an evicted range needs the time-to-segment index
 *   above. Not observed on a device.
 * - Nothing is trimmed BEHIND the playhead: a feed video LOOPS from its own buffer, which trimming
 *   would break (the loop would need a re-fetch), so the engine's own buffer quota and eviction
 *   bound it.
 */

import { SEGMENTED_MEDIA_ENCODING } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import { httpRangeSource, openSegmentedMedia } from './segmentedMediaReader';

/** The constructor MSE offers on this engine: the standard one, or Safari's managed one. */
export type MediaSourceConstructor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};

/** How a ref will be played, and the reason - logged, so a choice is never invisible. */
export type SegmentedPlayback =
  | { kind: 'stream'; MediaSourceCtor: MediaSourceConstructor; managed: boolean }
  | {
      kind: 'blob';
      reason: 'single-block' | 'not-av' | 'no-codecs' | 'no-media-source' | 'type-unsupported';
    };

/** The globals this choice reads - injected by the tests. */
export interface PlaybackEnvironment {
  MediaSource?: MediaSourceConstructor;
  ManagedMediaSource?: MediaSourceConstructor;
}

/**
 * Decides, from facts alone, whether `ref` streams through MSE or is read whole.
 *
 * @param ref The media to play.
 * @param env The engine's globals (defaults to `globalThis`).
 */
export function chooseSegmentedPlayback(
  ref: Pick<MediaRef, 'encoding' | 'type' | 'mimeType'>,
  env: PlaybackEnvironment = globalThis as unknown as PlaybackEnvironment
): SegmentedPlayback {
  if (ref.encoding !== SEGMENTED_MEDIA_ENCODING) return { kind: 'blob', reason: 'single-block' };
  if (ref.type !== 'video' && ref.type !== 'audio') return { kind: 'blob', reason: 'not-av' };
  if (!/;\s*codecs\s*=/i.test(ref.mimeType)) return { kind: 'blob', reason: 'no-codecs' };
  const managed = !env.MediaSource && !!env.ManagedMediaSource;
  const ctor = env.MediaSource ?? env.ManagedMediaSource;
  if (!ctor) return { kind: 'blob', reason: 'no-media-source' };
  if (!ctor.isTypeSupported(ref.mimeType)) return { kind: 'blob', reason: 'type-unsupported' };
  return { kind: 'stream', MediaSourceCtor: ctor, managed };
}

/** How far a PACED stream runs ahead of its element - see the file's header. */
export interface StreamPacing {
  /** Segments fetched whatever the element does: what a first frame needs. */
  headSegments: number;
  /** While the element plays, segments are fetched until this much is buffered past its playhead. */
  aheadSeconds: number;
}

/**
 * A feed card's pacing: two segments (2 MiB) of head - the first frame came with 2 of 20 on both
 * phones (2026-10-01) - and 10 s ahead while it plays, ~3 MB at the reel's 2.5 Mb/s.
 */
export const FEED_STREAM_PACING: StreamPacing = { headSegments: 2, aheadSeconds: 10 };

/** What a paced stream reads of its element - an `HTMLMediaElement`, or a test's stand-in. */
export type PacingElement = Pick<
  HTMLMediaElement,
  'paused' | 'currentTime' | 'buffered' | 'addEventListener' | 'removeEventListener'
>;

/** The element events after which its demand may have changed. */
const DEMAND_EVENTS = ['play', 'playing', 'waiting', 'timeupdate', 'seeking', 'progress'] as const;

/** A stream attached to one element. */
export interface SegmentedStreamHandle {
  /** The `src` for ONE media element - an MSE URL cannot be shared between two. */
  url: string;
  /**
   * The whole plaintext once every segment has been appended, so the lightbox and the download
   * reuse what was already decrypted instead of fetching it a second time. Rejects with the
   * reader's typed error (`SegmentedMediaError`, `MediaPurgedError`, `MediaRangeUnsupportedError`,
   * `MediaUnreachableError`). THE CONSUMER LOGS THAT REJECTION, by cause (`logMediaFailure`): the
   * stream says nothing of its own, so one failure is one line. A paced stream resolves it only once its element has asked for the last segment, or
   * {@link fetchAll} was called - a card scrolled past never does, and never builds the copy.
   */
  done: Promise<Blob>;
  /**
   * Names the element a PACED stream reads its demand from. Returns the detach. An unpaced stream
   * ignores it.
   */
  attach(element: PacingElement): () => void;
  /** Lifts the pacing: every remaining segment is fetched. Idempotent. */
  fetchAll(): void;
  /** Stops fetching - the segment in flight included - and releases the URL. Safe to call twice. */
  close(): void;
}

/** Resolves on the buffer's next `updateend`, rejects on its `error`. */
function appendSegment(buffer: SourceBuffer, bytes: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      buffer.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      buffer.removeEventListener('updateend', onEnd);
      reject(new Error('SourceBuffer refused an appended segment'));
    };
    buffer.addEventListener('updateend', onEnd, { once: true });
    buffer.addEventListener('error', onError, { once: true });
    buffer.appendBuffer(bytes);
  });
}

/** Seconds buffered past the element's playhead - 0 when the playhead is in no buffered range. */
export function bufferedAhead(element: Pick<PacingElement, 'currentTime' | 'buffered'>): number {
  const t = element.currentTime;
  const ranges = element.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && t <= ranges.end(i)) return ranges.end(i) - t;
  }
  return 0;
}

/**
 * Opens `ref` as a stream: the URL is usable at once, and segments are fetched, verified and
 * appended in order while it plays.
 *
 * @param ref      A ref {@link chooseSegmentedPlayback} chose `stream` for.
 * @param baseUrl  The media service's base URL.
 * @param playback That choice, carrying the constructor to use.
 * @param pacing   Fetch only what the attached element is about to play ({@link StreamPacing});
 *   absent, the whole file is fetched as fast as it comes.
 */
export function openSegmentedStream(
  ref: MediaRef,
  baseUrl: string,
  playback: Extract<SegmentedPlayback, { kind: 'stream' }>,
  pacing?: StreamPacing
): SegmentedStreamHandle {
  console.debug(
    `[media-seg] stream ${ref.mediaId} (${ref.mimeType}) through ${playback.managed ? 'ManagedMediaSource' : 'MediaSource'}${pacing ? `, paced (${pacing.headSegments} head, ${pacing.aheadSeconds} s ahead)` : ''}`
  );
  const abort = new AbortController();
  const source = new playback.MediaSourceCtor();
  const url = URL.createObjectURL(source);
  let closed = false;
  let paced = !!pacing;
  let element: PacingElement | null = null;
  /** Wakes a fetch loop waiting for demand; replaced on every wait. */
  let wake: (() => void) | null = null;
  const poke = () => wake?.();
  // A close wakes a waiting loop, which then sees the abort and stops.
  abort.signal.addEventListener('abort', poke, { once: true });
  if (playback.managed) {
    source.addEventListener('startstreaming', poke);
    source.addEventListener('endstreaming', poke);
  }

  /**
   * Safari's `ManagedMediaSource` says itself when it wants bytes: `streaming` is false between its
   * `endstreaming` and `startstreaming` events (memory pressure, a hidden page), and a paced stream
   * honours it on top of its element's demand. A standard `MediaSource` has no such property.
   */
  const managedSource = source as MediaSource & { streaming?: boolean };

  /** Whether segment `index` may be fetched now. */
  function wanted(index: number): boolean {
    if (!paced || !pacing || index < pacing.headSegments) return true;
    if (playback.managed && managedSource.streaming === false) return false;
    if (!element || element.paused) return false;
    return bufferedAhead(element) < pacing.aheadSeconds;
  }

  /** Resolves once segment `index` is wanted; rejects when the stream is closed meanwhile. */
  async function demand(index: number): Promise<void> {
    if (wanted(index)) return;
    console.debug(`[media-seg] stream ${ref.mediaId}: holding at segment ${index} (paced)`);
    while (!wanted(index)) {
      if (abort.signal.aborted) throw new DOMException('stream closed', 'AbortError');
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
    if (abort.signal.aborted) throw new DOMException('stream closed', 'AbortError');
    console.debug(`[media-seg] stream ${ref.mediaId}: resuming at segment ${index}`);
  }

  const done = (async () => {
    await new Promise<void>((resolve) =>
      source.addEventListener('sourceopen', () => resolve(), { once: true })
    );
    const buffer = source.addSourceBuffer(ref.mimeType);
    const reader = await openSegmentedMedia(
      httpRangeSource(baseUrl, ref.mediaId),
      ref.key,
      ref.iv,
      abort.signal
    );
    // Each segment is kept as a BLOB, never as the `ArrayBuffer` it was decrypted into: the buffer
    // is dropped the moment the element has it, and the bytes the final file needs sit in the
    // engine's blob store (which spills to disk) instead of the JS heap, beside the MSE buffer.
    const parts: Blob[] = [];
    for (let i = 0; i < reader.segmentCount; i++) {
      await demand(i);
      const plain = await reader.readSegment(i, abort.signal);
      if (closed) throw new DOMException('stream closed', 'AbortError');
      await appendSegment(buffer, plain);
      parts.push(new Blob([plain]));
    }
    if (source.readyState === 'open') source.endOfStream();
    console.debug(`[media-seg] stream ${ref.mediaId}: ${reader.segmentCount} segment(s) appended`);
    return new Blob(parts, { type: ref.mimeType });
  })();

  // NOT LOGGED HERE: `done` is handed to the consumer, which logs the failure by its cause - a range
  // that got no answer is the expected state of an absent link, not an error. Logging here too
  // printed every failure twice, once at `error` whatever its cause (production 1.5.1).
  done.catch(() => {
    if (closed) return;
    // Tells the element the stream is broken rather than leaving it waiting for bytes for ever.
    if (source.readyState === 'open') source.endOfStream('decode');
  });

  return {
    url,
    done,
    attach(next) {
      if (!pacing) return () => {};
      element = next;
      for (const type of DEMAND_EVENTS) next.addEventListener(type, poke);
      poke();
      return () => {
        for (const type of DEMAND_EVENTS) next.removeEventListener(type, poke);
        if (element === next) element = null;
      };
    },
    fetchAll() {
      if (!paced) return;
      console.debug(`[media-seg] stream ${ref.mediaId}: pacing lifted, fetching the rest`);
      paced = false;
      poke();
    },
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      URL.revokeObjectURL(url);
    },
  };
}
