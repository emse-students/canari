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
 * # What is NOT here yet
 *
 * - SEEKING AHEAD of the download waits for it: segments are appended in order. The reader can fetch
 *   any one segment (`SegmentedMediaReader.segmentForOffset`), but mapping a TIME to a byte offset
 *   needs the container's index (a WebM `Cues`, an MP4 `sidx`), and that belongs with the capture
 *   that writes the container (R3).
 * - No recorder writes a codecs-bearing ref yet. The path was READ on both phones (2026-10-01) with
 *   a blob sealed by `encryptSegmentedMedia`: the Mi 9T streams through `MediaSource`, the iPhone's
 *   WKWebView exposes `ManagedMediaSource` and streams through it - first frame with 2 of 20
 *   segments in hand on both (docs/wiki/services/media-service.md, "Read on both phones").
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

/** A stream attached to one element. */
export interface SegmentedStreamHandle {
  /** The `src` for ONE media element - an MSE URL cannot be shared between two. */
  url: string;
  /**
   * The whole plaintext once every segment has been appended, so the lightbox and the download
   * reuse what was already decrypted instead of fetching it a second time. Rejects with the
   * reader's typed error (`SegmentedMediaError`, `MediaPurgedError`, `MediaRangeUnsupportedError`).
   */
  done: Promise<Blob>;
  /** Stops fetching and releases the URL. Safe to call twice. */
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

/**
 * Opens `ref` as a stream: the URL is usable at once, and segments are fetched, verified and
 * appended in order while it plays.
 *
 * @param ref      A ref {@link chooseSegmentedPlayback} chose `stream` for.
 * @param baseUrl  The media service's base URL.
 * @param playback That choice, carrying the constructor to use.
 */
export function openSegmentedStream(
  ref: MediaRef,
  baseUrl: string,
  playback: Extract<SegmentedPlayback, { kind: 'stream' }>
): SegmentedStreamHandle {
  console.debug(
    `[media-seg] stream ${ref.mediaId} (${ref.mimeType}) through ${playback.managed ? 'ManagedMediaSource' : 'MediaSource'}`
  );
  const abort = new AbortController();
  const source = new playback.MediaSourceCtor();
  const url = URL.createObjectURL(source);
  let closed = false;

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
    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < reader.segmentCount; i++) {
      const plain = await reader.readSegment(i, abort.signal);
      parts.push(plain);
      if (closed) throw new DOMException('stream closed', 'AbortError');
      await appendSegment(buffer, plain);
    }
    if (source.readyState === 'open') source.endOfStream();
    console.debug(`[media-seg] stream ${ref.mediaId}: ${reader.segmentCount} segment(s) appended`);
    return new Blob(parts, { type: ref.mimeType });
  })();

  done.catch((err) => {
    if (closed) return;
    console.error(`[media-seg] stream ${ref.mediaId} stopped`, err);
    // Tells the element the stream is broken rather than leaving it waiting for bytes for ever.
    if (source.readyState === 'open') source.endOfStream('decode');
  });

  return {
    url,
    done,
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      URL.revokeObjectURL(url);
    },
  };
}
