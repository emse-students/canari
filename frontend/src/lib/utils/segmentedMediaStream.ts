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
 * The full-screen viewer is a FORK of the card's stream ({@link SegmentedStreamHandle.fork}): its
 * own MediaSource and element, the same segment feed, paced by {@link VIEWER_STREAM_PACING}. It
 * plays as soon as its head is appended and never waits for the whole file; a segment is fetched
 * once however many elements read it. An UNPACED stream (the live viewer's replay, a gallery
 * cell) fetches the whole file as fast as it comes, and {@link SegmentedStreamHandle.fetchAll}
 * turns a paced one into it.
 *
 * # A link slower than the media stops ONCE, not once per segment
 *
 * Appending each segment as it lands lets the engine resume on it, play its few seconds and starve
 * again - 29 stalls on the owner's link (slow-link chantier, gap 6). So when the measured link is
 * slower than the media ({@link linkIsSlow}, with hysteresis) and the element has fired `waiting`,
 * the stream keeps fetching but holds the segments back until the rest can play through
 * ({@link holdTargetSeconds}), then appends them in one go. Nothing of it is shown (owner,
 * 2026-11-11): the element just waits, as it would for any slow byte. The link is measured in `httpRangeSource`, after the request
 * gate granted the slot. Mechanism and numbers: `docs/wiki/frontend/modules/video-player.md`.
 *
 * # What is NOT here yet
 *
 * - SEEKING AHEAD of the download waits for it: segments are appended in order. The reader can fetch
 *   any one segment (`SegmentedMediaReader.segmentForOffset`), but mapping a TIME to a byte offset
 *   needs the container's index (a WebM `Cues`, an MP4 `sidx`), and that belongs with the capture
 *   that writes the container (R3).
 * - A closed stream re-fetches its head when it is opened again: the segments it had are not kept
 *   anywhere but the element it fed, which closing released - unless the reel viewer's look-ahead
 *   still holds that head (`mediaHeadStore.ts`), which the feed then joins.
 * - A range the ENGINE EVICTS from the buffer is not fetched again: segments go in once, in order. A
 *   `ManagedMediaSource` (iPhone) may evict under memory pressure and stall there - the pacing
 *   honours its `streaming` flag, but re-fetching an evicted range needs the time-to-segment index
 *   above. Not observed on a device. Until then a seek before the cut is CLAMPED to what is still
 *   buffered ({@link streamSeekFloor}, read by `VideoPlayer.seekTo`) rather than left to stall.
 * - Nothing is trimmed BEHIND the playhead: a feed video LOOPS from its own buffer, which trimming
 *   would break (the loop would need a re-fetch), so the engine's own buffer quota and eviction
 *   bound it.
 */

import { SEGMENTED_MEDIA_ENCODING, SEGMENTED_MEDIA_SEGMENT_BYTES } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import { httpRangeSource, openSegmentedMedia } from './segmentedMediaReader';
import { isMp4Type, writeMvhdDuration } from './mp4Duration';
import { LinkRateMeter, sessionLinkRate } from './linkRate';
import { headedRangeSource, joinMediaHead } from './mediaHeadStore';

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

/**
 * THE LINK IS CALLED SLOW below this share of the media's rate: `link / media < 1` - it delivers
 * less than a second of media per second played, so playing as bytes land can only stall.
 */
export const SLOW_LINK_BELOW = 1;

/**
 * ...and FAST AGAIN only once `link / media` reaches this: the HYSTERESIS that keeps a rate
 * hovering around 1 from flipping the stream between holding and not holding on every sample.
 */
export const FAST_LINK_FROM = 1.15;

/** Margin on the hold's target: a measured rate is an average, and the link wobbles around it. */
export const HOLD_SAFETY = 1.1;

/** The most a slow link's stream holds ahead of its playhead, in seconds - the viewer's own bound. */
export const SLOW_AHEAD_MAX_SECONDS = 30;

/**
 * The same bound in bytes of media. A hold appends all of it in one go, so it is kept small; the
 * engine's own quota is NOT measured here - an append it refuses goes through
 * `appendSegmentEvicting`, which trims what was played and tries once more.
 */
export const SLOW_AHEAD_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Whether the link is slow now, from `link / media` and what it was called before
 * ({@link SLOW_LINK_BELOW}, {@link FAST_LINK_FROM}). An unknown ratio keeps the last answer.
 */
export function linkIsSlow(ratio: number | null, wasSlow: boolean): boolean {
  if (ratio === null) return wasSlow;
  return wasSlow ? ratio < FAST_LINK_FROM : ratio < SLOW_LINK_BELOW;
}

/**
 * How far ahead a slow link's stream fetches and holds: the smaller of
 * {@link SLOW_AHEAD_MAX_SECONDS} and {@link SLOW_AHEAD_MAX_BYTES} of media, never below the
 * pacing's own `baseSeconds`.
 */
export function slowAheadCapSeconds(baseSeconds: number, mediaBytesPerSecond: number): number {
  return Math.max(
    baseSeconds,
    Math.min(SLOW_AHEAD_MAX_SECONDS, SLOW_AHEAD_MAX_BYTES / mediaBytesPerSecond)
  );
}

/**
 * HOW MUCH MUST BE BUFFERED BEFORE A STARVED ELEMENT IS GIVEN ITS BYTES BACK, so it then plays to
 * the end without stopping again (slow-link chantier, gap 6: a reel at ~318 KB/s on a ~262 KB/s link
 * stopped 29 times).
 *
 * With `B` seconds buffered, `U` bytes still to fetch, a link at `l` and a media at `m` bytes per
 * second, the buffer never runs dry iff `B >= (U / m) x (m / l - 1)`. Written with the remaining
 * playing time `R = B + U / m` it is the chantier's rule, `B >= R x (1 - l / m)`: the same bound,
 * read without the element's `duration`. A link at or above the media's rate needs nothing. Taken
 * with {@link HOLD_SAFETY}, and never above `capSeconds` - a long video on a very slow link holds
 * again later rather than buffering past the engine's quota.
 */
export function holdTargetSeconds(input: {
  unfetchedBytes: number;
  linkBytesPerSecond: number;
  mediaBytesPerSecond: number;
  capSeconds: number;
}): number {
  const { unfetchedBytes: u, linkBytesPerSecond: l, mediaBytesPerSecond: m, capSeconds } = input;
  if (l >= m || u <= 0) return 0;
  return Math.min(capSeconds, (u / m) * (m / l - 1) * HOLD_SAFETY);
}

/** What a paced stream reads of its element - an `HTMLMediaElement`, or a test's stand-in. */
export type PacingElement = Pick<
  HTMLMediaElement,
  'paused' | 'currentTime' | 'buffered' | 'addEventListener' | 'removeEventListener'
>;

/** The element events after which its demand may have changed. */
const DEMAND_EVENTS = [
  'play',
  'playing',
  'pause',
  'waiting',
  'timeupdate',
  'seeking',
  'progress',
] as const;

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
  /**
   * A second stream over the SAME segments, for a second element (the full-screen viewer): its own
   * URL, paced by {@link VIEWER_STREAM_PACING}. A segment the first stream already fetched is
   * taken from the shared feed, and one the fork fetches is the first stream's too - the file is
   * never downloaded twice, and the viewer starts as soon as ITS head is appended. Closing the fork
   * stops only the fork; closing the original stops both. A fork is not forked again.
   */
  fork(): SegmentedStreamHandle;
  /** Stops fetching - the segment in flight included - and releases the URL. Safe to call twice. */
  close(): void;
}

/**
 * How far one stream has got: what the in-app log's one line per reel view reads when the view ends
 * (`reels/reelViewOutcome.ts`), so a reel that never showed a frame names where its bytes stopped.
 * Mutated in place by the stream, never by a reader.
 */
export interface StreamProgress {
  /** The segment count the file's header announced - `null` until that header has been read. */
  segmentCount: number | null;
  /** Segments verified and appended to the element's buffer. */
  appended: number;
  /** Plaintext bytes appended. */
  bytes: number;
  /**
   * Where the stream CUT its own buffer to take a segment (`appendSegmentEvicting`), in seconds -
   * `0` while nothing was cut. Segments go in once and in order, so nothing before this point will
   * ever be buffered again: a seek there would wait for ever ({@link streamSeekFloor}).
   */
  trimmedBefore: number;
}

/**
 * THE EARLIEST TIME A STREAMED ELEMENT CAN STILL BE SOUGHT TO. A declared duration makes the
 * engine's `seekable` range the whole clip, but a stream appends each segment once and never goes
 * back: what its own trim removed ({@link StreamProgress.trimmedBefore}) or the engine evicted
 * (Safari's `ManagedMediaSource` under pressure, Chromium's quota) is gone, and a seek before it
 * stalls with no byte coming. The floor is the later of the stream's cut and the start of what the
 * element still buffers.
 *
 * @param progress The stream's progress ({@link streamProgressOf}); `undefined` for a whole file.
 * @param buffered The element's `buffered` ranges.
 */
export function streamSeekFloor(
  progress: Pick<StreamProgress, 'trimmedBefore'> | undefined,
  buffered: Pick<TimeRanges, 'length' | 'start'>
): number {
  const cut = progress?.trimmedBefore ?? 0;
  const head = buffered.length > 0 ? buffered.start(0) : 0;
  return Math.max(cut, head);
}

/** Every open stream's progress, by its MSE URL - the one name the element and its owner share. */
const progressByUrl = new Map<string, StreamProgress>();

/**
 * The live progress of the open stream whose URL is `url`, or `undefined` when no stream owns that
 * URL (a whole blob, or a stream already closed). The object is the stream's own: a caller that
 * keeps it reads the last state reached even after the stream closes.
 */
export function streamProgressOf(url: string): StreamProgress | undefined {
  return progressByUrl.get(url);
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

/** Seconds kept behind the playhead when a full buffer is trimmed to take the next segment. */
const QUOTA_KEEP_BEHIND_SECONDS = 10;

/** Waits for a `SourceBuffer` to finish what it is doing (`remove` is asynchronous). */
function settled(buffer: SourceBuffer): Promise<void> {
  if (!buffer.updating) return Promise.resolve();
  return new Promise((resolve) =>
    buffer.addEventListener('updateend', () => resolve(), { once: true })
  );
}

/**
 * Appends a segment; when the engine's buffer is full (`QuotaExceededError`: nothing evicts behind
 * the playhead on a long video, and the card and the viewer each hold a buffer) the already-played
 * part is removed and the append retried ONCE. The whole file is built from the segment Blobs, never
 * from this buffer, so trimming costs only a seek back into the removed part - which beats a
 * `decode` error that ends the video.
 */
async function appendSegmentEvicting(
  buffer: SourceBuffer,
  bytes: ArrayBuffer,
  element: () => PacingElement | null,
  mediaId: string,
  progress: StreamProgress
): Promise<void> {
  try {
    await appendSegment(buffer, bytes);
  } catch (err) {
    const el = element();
    const isQuota = err instanceof DOMException && err.name === 'QuotaExceededError';
    const cut = (el?.currentTime ?? 0) - QUOTA_KEEP_BEHIND_SECONDS;
    if (!isQuota || !el || cut <= 0) throw err;
    console.warn(`[media-seg] stream ${mediaId}: buffer full, trimming before ${cut.toFixed(1)} s`);
    // Said BEFORE the removal: a seek decided meanwhile must already see the floor.
    progress.trimmedBefore = Math.max(progress.trimmedBefore, cut);
    await settled(buffer);
    buffer.remove(0, cut);
    await settled(buffer);
    await appendSegment(buffer, bytes);
  }
}

/**
 * Whether `seconds` lies in what the element buffers. A stream appends each segment once, so a time
 * outside every range is either ahead (fetched in order, at the cost of every segment before it) or
 * behind a cut (never again) - a hand-over seek is only free inside one.
 */
export function isTimeBuffered(
  buffered: Pick<TimeRanges, 'length' | 'start' | 'end'>,
  seconds: number
): boolean {
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= seconds && seconds <= buffered.end(i)) return true;
  }
  return false;
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
 * The viewer's pacing: the head, then 30 s ahead while it plays. Longer than a feed card's - the
 * reader chose this video and watches it full screen - yet still bounded, so a 33 MB video left
 * after ten seconds is not fetched whole.
 */
export const VIEWER_STREAM_PACING: StreamPacing = { headSegments: 2, aheadSeconds: 30 };

/**
 * The segments of ONE media, fetched at most once whoever asks. Every consumer of the stream - the
 * inline element, a viewer forked from it - reads through this, so a second element never means a
 * second download: a segment already in is a `Blob` in the engine's store (which spills to disk),
 * and the next consumer simply takes it.
 */
interface SegmentFeed {
  /** How many segments the media has - opens the reader on first use. */
  count(): Promise<number>;
  /** Segment `index`, fetched and verified the first time it is asked for. */
  segment(index: number): Promise<Blob>;
  /**
   * What this media's ranged reads achieved, bytes per second, smoothed over the last ones - `null`
   * before one has been measured. Measured inside the read, after the request gate granted its slot
   * (`httpRangeSource`), so neither the queue nor a segment a second consumer finds already in the
   * feed counts as the link.
   */
  linkBytesPerSecond(): number | null;
}

/**
 * A feed over `ref`; every read is aborted with `signal` (the root stream's close).
 *
 * A HEAD FETCHED AHEAD IS JOINED, NEVER FETCHED AGAIN (owner, 2026-11-11): when the reel viewer's
 * look-ahead holds this media's first bytes (`mediaHeadStore.ts`), the feed takes its own hold on
 * them and its reads inside them are answered from memory - the bytes in flight included - so the
 * stream's first segments cost no second request. The hold is given back with the root's close.
 */
function createSegmentFeed(
  ref: MediaRef,
  baseUrl: string,
  signal: AbortSignal,
  clock: () => number
): SegmentFeed {
  const meter = new LinkRateMeter();
  const observe = (bytes: number, seconds: number) => {
    meter.observe(bytes, seconds);
    sessionLinkRate.observe(bytes, seconds);
  };
  const network = httpRangeSource(baseUrl, ref.mediaId, observe, clock);
  const head = joinMediaHead(ref.mediaId);
  if (head) {
    console.debug(`[media-seg] stream ${ref.mediaId}: joins the head fetched ahead`);
    signal.addEventListener('abort', () => head.release(), { once: true });
  }
  const source = head ? headedRangeSource(head, network) : network;
  let reader: ReturnType<typeof openSegmentedMedia> | null = null;
  // A FAILURE IS NOT MEMOISED: a transient range error on the card's read must not be handed to the
  // viewer forever - the next consumer asks again (a closed root rejects them all anyway).
  const open = () => {
    if (!reader) {
      const opening = openSegmentedMedia(source, ref.key, ref.iv, signal);
      reader = opening;
      opening.catch(() => {
        if (reader === opening) reader = null;
      });
    }
    return reader;
  };
  const segments = new Map<number, Promise<Blob>>();
  return {
    count: async () => (await open()).segmentCount,
    segment(index) {
      let pending = segments.get(index);
      if (!pending) {
        // Each segment is kept as a BLOB, never as the `ArrayBuffer` it was decrypted into: the
        // buffer is dropped once read, and what the final file needs sits in the engine's blob
        // store instead of the JS heap, beside the MSE buffer.
        pending = open().then(async (r) => new Blob([await r.readSegment(index, signal)]));
        segments.set(index, pending);
        const asked = pending;
        asked.catch(() => {
          if (segments.get(index) === asked) segments.delete(index);
        });
      }
      return pending;
    },
    linkBytesPerSecond: () => meter.bytesPerSecond,
  };
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
 * @param clock    Milliseconds, for measuring the link; a test's stand-in drives it.
 */
export function openSegmentedStream(
  ref: MediaRef,
  baseUrl: string,
  playback: Extract<SegmentedPlayback, { kind: 'stream' }>,
  pacing?: StreamPacing,
  clock: () => number = () => performance.now()
): SegmentedStreamHandle {
  const rootAbort = new AbortController();
  const feed = createSegmentFeed(ref, baseUrl, rootAbort.signal, clock);
  return openConsumer(ref, feed, playback, pacing, rootAbort, 'stream');
}

/**
 * THE STREAM KNOWS HOW LONG IT LASTS BEFORE ITS FIRST BYTE (owner, 2026-11-10: "on ne peut plus
 * avancer dans les videos"). A file written before its writer declared its length (`mp4Duration.ts`)
 * gives the MSE parser an init segment with no duration, so the element reads `Infinity` until the
 * LAST segment is appended - which a paced stream never does - and its `seekable` range ends at what
 * is buffered: the scrubber has nothing to map onto, a resume is clamped to the buffered head. The
 * sender's DECLARED length (`MediaRef.durationMs`: a conversation's video, a reel's post) is set on
 * the source as soon as it opens, before any buffer exists - the one moment the spec allows it with
 * nothing to truncate. Undeclared, the file's own header answers (every upload since the fix).
 */
function declareStreamDuration(
  source: MediaSource,
  ref: MediaRef,
  label: string,
  closed: boolean
): void {
  const ms = ref.durationMs;
  if (!ms || ms <= 0) return;
  // A stream closed before its source opened (a card scrolled past at once) has nothing to declare:
  // the ordinary close, not a refusal worth a warning.
  if (closed || source.readyState !== 'open') return;
  try {
    source.duration = ms / 1000;
    console.debug(`[media-seg] ${label} ${ref.mediaId}: declared duration ${ms} ms`);
  } catch (e) {
    // Only an engine that broke the spec (an open source with no buffer) lands here: said, loudly.
    console.warn(`[media-seg] ${label} ${ref.mediaId}: the declared duration was refused`, e);
  }
}

/**
 * The whole file the segments make, its movie duration declared when it was not (`mp4Duration.ts`).
 * ONLY THE HEAD IS COPIED: the segments stay the engine's `Blob`s (spilled to disk), and the first
 * one - the `moov` is in it - is read, patched in a copy and put in front. Reading every segment
 * back into one `Uint8Array` held 2-3x a 35 MB reel in the JS heap on the Mi 9T (review of #3311).
 *
 * @param seconds How long the stream played to its end: the source's `duration` after
 *   `endOfStream`, or the sender's declared length.
 */
async function wholeFile(ref: MediaRef, parts: Blob[], seconds: number): Promise<Blob> {
  if (ref.type !== 'video' || !isMp4Type(ref.mimeType) || parts.length === 0) {
    return new Blob(parts, { type: ref.mimeType });
  }
  const patched = writeMvhdDuration(new Uint8Array(await parts[0].arrayBuffer()), seconds);
  if (!patched) return new Blob(parts, { type: ref.mimeType });
  console.info(
    `[media-seg] ${ref.mediaId}: undeclared movie duration - ${seconds.toFixed(2)} s written into its head`
  );
  return new Blob([patched, ...parts.slice(1)], { type: ref.mimeType });
}

/** How long a finished stream lasts: what the engine measured, else what the sender declared. */
function playedSeconds(source: MediaSource, ref: MediaRef): number {
  if (Number.isFinite(source.duration) && source.duration > 0) return source.duration;
  return ref.durationMs && ref.durationMs > 0 ? ref.durationMs / 1000 : 0;
}

/**
 * One MSE consumer of a feed: its own `MediaSource`, URL and pacing. The root consumer owns the
 * feed's abort; a fork's close stops only itself.
 */
function openConsumer(
  ref: MediaRef,
  feed: SegmentFeed,
  playback: Extract<SegmentedPlayback, { kind: 'stream' }>,
  pacing: StreamPacing | undefined,
  rootAbort: AbortController,
  label: 'stream' | 'viewer'
): SegmentedStreamHandle {
  console.debug(
    `[media-seg] ${label} ${ref.mediaId} (${ref.mimeType}) through ${playback.managed ? 'ManagedMediaSource' : 'MediaSource'}${pacing ? `, paced (${pacing.headSegments} head, ${pacing.aheadSeconds} s ahead)` : ''}`
  );
  // The root's close reaches every consumer; a fork's close stops only itself.
  const abort = label === 'stream' ? rootAbort : new AbortController();
  if (label === 'viewer') {
    rootAbort.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  const source = new playback.MediaSourceCtor();
  const url = URL.createObjectURL(source);
  const progress: StreamProgress = {
    segmentCount: null,
    appended: 0,
    bytes: 0,
    trimmedBefore: 0,
  };
  progressByUrl.set(url, progress);
  let closed = false;
  let paced = !!pacing;
  let element: PacingElement | null = null;
  /** The element fired `waiting` and has not played since: it stalls, and a slow link holds it. */
  let starved = false;
  /** The link's last verdict ({@link linkIsSlow}), kept for the hysteresis. */
  let slow = false;
  /** Every segment is fetched: nothing a hold could still wait for (set after the fetch loop). */
  let fetchedAll = false;
  /** A hold is on: said once in the log when it starts, once when it ends. */
  let holding = false;
  /**
   * Segments fetched and not appended yet, in order: what a hold keeps from a starved element so it
   * plays once, to the end, instead of a second at a time.
   */
  const held: Blob[] = [];
  let heldBytes = 0;
  /** Every append, in order, whoever releases it - the fetch loop or an element's event. */
  let appendChain: Promise<void> = Promise.resolve();
  let buffer: SourceBuffer | null = null;
  // The segments are kept as the feed's BLOBS: the `ArrayBuffer` read for the append is dropped
  // once appended, so the whole file never sits in the JS heap (see `wholeFile`).
  const parts: Blob[] = [];
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
    if (!element) return false;
    // A seek past what is buffered on a PAUSED element is a demand too: without it the picture
    // stays black until the reader presses play (`seeking` is true until the data is in).
    if (element.paused && !(element as { seeking?: boolean }).seeking) return false;
    // A SLOW LINK FETCHES WITHOUT A PAUSE up to its cap: holding at the pacing's lookahead would
    // leave the link idle while the buffer drains faster than it fills.
    const rates = linkRates();
    if (rates && slow) {
      return (
        aheadWithHeld(element, rates.media) < slowAheadCapSeconds(pacing.aheadSeconds, rates.media)
      );
    }
    return bufferedAhead(element) < pacing.aheadSeconds;
  }

  /**
   * Bytes of media per second played: the file's size over its declared length, else what the
   * stream has appended over what the element buffers (only while nothing was cut from its start).
   */
  function mediaBytesPerSecond(): number | null {
    if (ref.durationMs && ref.durationMs > 0 && ref.size > 0) {
      return ref.size / (ref.durationMs / 1000);
    }
    const ranges = element?.buffered;
    if (!ranges || ranges.length === 0 || progress.trimmedBefore > 0 || progress.bytes <= 0) {
      return null;
    }
    const seconds = ranges.end(ranges.length - 1) - ranges.start(0);
    return seconds > 0 ? progress.bytes / seconds : null;
  }

  /**
   * The measured link and media rates, `null` while either is unknown - and the link's verdict
   * ({@link linkIsSlow}) brought up to date, said once when it changes.
   */
  function linkRates(): { link: number; media: number } | null {
    const link = feed.linkBytesPerSecond();
    const media = mediaBytesPerSecond();
    if (!link || !media) return null;
    const next = linkIsSlow(link / media, slow);
    if (next !== slow) {
      slow = next;
      console.debug(
        `[media-seg] ${label} ${ref.mediaId}: link ${Math.round(link / 1024)} KiB/s, media ${Math.round(media / 1024)} KiB/s - ${slow ? 'slower than the media: a stall is held until the rest can play through' : 'keeps up again'}`
      );
    }
    return { link, media };
  }

  /** Seconds ahead of the element's playhead, counting what a hold keeps from it. */
  function aheadWithHeld(el: PacingElement, media: number): number {
    return bufferedAhead(el) + heldBytes / media;
  }

  /**
   * What a starved element still lacks before it may play on: the seconds it has (buffered plus
   * held) and the {@link holdTargetSeconds} it needs - `null` when no hold applies: the element is
   * not stalling, the link keeps up, or enough is in for it to play to the end. A hold starts only
   * on a `waiting` and ends at its target - or earlier, on purpose, when the link is called fast
   * again (from 1.15x), when the element is paused, played or detached, or when every segment is
   * fetched. NOTHING OF IT IS SHOWN (owner, 2026-11-11): the element is simply waiting, and the
   * player draws what it draws for any wait.
   */
  function holdShortfall(): { ahead: number; target: number } | null {
    // A FACT, NOT ARITHMETIC: once every segment is in, nothing is left to wait for, whatever a
    // wrong or absent `ref.size` makes `unfetchedBytes` say.
    if (fetchedAll) return null;
    if (!pacing || !element || element.paused || !starved) return null;
    const rates = linkRates();
    if (!rates || !slow) return null;
    const total =
      ref.size > 0 ? ref.size : (progress.segmentCount ?? 0) * SEGMENTED_MEDIA_SEGMENT_BYTES;
    const target = holdTargetSeconds({
      unfetchedBytes: Math.max(0, total - progress.bytes - heldBytes),
      linkBytesPerSecond: rates.link,
      mediaBytesPerSecond: rates.media,
      capSeconds: slowAheadCapSeconds(pacing.aheadSeconds, rates.media),
    });
    const ahead = aheadWithHeld(element, rates.media);
    return ahead >= target ? null : { ahead, target };
  }

  /** Logs a hold's start (with its target) and its end - the only trace a hold leaves. */
  function noteHold(shortfall: { ahead: number; target: number } | null): void {
    if ((shortfall !== null) === holding) return;
    holding = shortfall !== null;
    if (shortfall) {
      console.debug(
        `[media-seg] ${label} ${ref.mediaId}: holding a stall, ${shortfall.ahead.toFixed(1)} s of ${shortfall.target.toFixed(1)} s in`
      );
    } else {
      console.debug(
        `[media-seg] ${label} ${ref.mediaId}: hold released, ${held.length} held segment(s) appended`
      );
    }
  }

  /**
   * Appends what is held unless a hold applies ({@link holdShortfall}). Called after every fetch and
   * on every element event; the appends themselves go through ONE chain, so they stay in order.
   */
  function release(): void {
    const shortfall = holdShortfall();
    noteHold(shortfall);
    if (shortfall !== null || held.length === 0 || !buffer) return;
    appendChain = appendChain.then(drain);
    // The fetch loop awaits the chain: a failed append rejects `done` there, said by its consumer.
    appendChain.catch(() => {});
  }

  /**
   * Appends every held segment, in order. ONCE STARTED, A DRAIN APPENDS EVERYTHING HELD: those bytes
   * are already here, and stopping a burst half-way would only turn one release into two stalls. A
   * new `waiting` cannot arise mid-burst (the burst is what the element was waiting for).
   */
  async function drain(): Promise<void> {
    while (held.length > 0 && buffer) {
      if (closed) throw new DOMException('stream closed', 'AbortError');
      const segment = held[0];
      const part = await segment.arrayBuffer();
      if (closed) throw new DOMException('stream closed', 'AbortError');
      await appendSegmentEvicting(buffer, part, () => element, ref.mediaId, progress);
      held.shift();
      heldBytes -= segment.size;
      progress.appended += 1;
      progress.bytes += part.byteLength;
      parts.push(segment);
    }
  }

  /** An element event: its stall state first, then what it releases and what it asks for. */
  function onElementEvent(event: Event): void {
    if (event.type === 'waiting') starved = true;
    else if (event.type === 'playing' || event.type === 'pause') starved = false;
    release();
    poke();
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
    declareStreamDuration(source, ref, label, closed);
    buffer = source.addSourceBuffer(ref.mimeType);
    const segmentCount = await feed.count();
    progress.segmentCount = segmentCount;
    for (let i = 0; i < segmentCount; i++) {
      await demand(i);
      const segment = await feed.segment(i);
      if (closed) throw new DOMException('stream closed', 'AbortError');
      held.push(segment);
      heldBytes += segment.size;
      // Appended at once - unless a starved element on a slow link is being held, in which case
      // the loop fetches on and the segment waits with the others (`holdShortfall`).
      release();
      await appendChain;
    }
    // Nothing is left to fetch: what is held goes in, whatever the arithmetic says (`fetchedAll`).
    fetchedAll = true;
    release();
    await appendChain;
    if (source.readyState === 'open') source.endOfStream();
    console.debug(`[media-seg] ${label} ${ref.mediaId}: ${segmentCount} segment(s) appended`);
    return wholeFile(ref, parts, playedSeconds(source, ref));
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
      starved = false;
      for (const type of DEMAND_EVENTS) next.addEventListener(type, onElementEvent);
      poke();
      return () => {
        for (const type of DEMAND_EVENTS) next.removeEventListener(type, onElementEvent);
        if (element === next) {
          element = null;
          starved = false;
          // A detached element is held by nobody: what was kept from it goes in.
          release();
        }
      };
    },
    fetchAll() {
      if (!paced) return;
      console.debug(`[media-seg] stream ${ref.mediaId}: pacing lifted, fetching the rest`);
      paced = false;
      poke();
    },
    fork() {
      if (label === 'viewer') throw new Error('a viewer stream is not forked again');
      return openConsumer(ref, feed, playback, VIEWER_STREAM_PACING, rootAbort, 'viewer');
    },
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      progressByUrl.delete(url);
      URL.revokeObjectURL(url);
    },
  };
}
