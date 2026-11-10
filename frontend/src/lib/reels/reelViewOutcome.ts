/**
 * ONE LINE PER REEL VIEW, WRITTEN WHEN THE VIEW ENDS - whether the reel showed its first frame, how
 * long that took, and, when it never did, WHERE ITS LOAD STOPPED.
 *
 * WHY (owner, 2026-11-09, Android, 1.6.8): CanaReels "did not load", and the week of in-app log he
 * exported held not one line about a reel: every reel diagnostic (load, buffering, stall, segment,
 * first frame) is a debug line, and the in-app log records none (`appLog.ts`). A failure the code
 * DECIDES is already a warn or an error (`logMediaFailure`, `[VideoPlayer] the engine refused the
 * video`); what left no trace is the reel that neither failed nor played - a download still
 * running, a stream waiting for a range, an element that never decoded. Nothing can decide that
 * state while it lasts without a clock, so it is said at the one event that ends it for certain:
 * the reader leaving the reel (a swipe, the viewer closed). See
 * [reels](docs/wiki/frontend/modules/reels.md#one-line-per-reel-view-the-outcome-the-in-app-log-carries-owner-2026-11-09).
 *
 * The facts are collected by the reel's pane (`ReelMediaPane.svelte`) from what it already hears:
 * the `<video>`'s own events in the capture phase, `PostMedia`'s callbacks, the stream's progress
 * (`streamProgressOf`), the preload's state and the media gate's counts. Nothing here measures by
 * waiting; the clock only stamps events that happened.
 */
import type { SegmentedPlayback, StreamProgress } from '$lib/utils/segmentedMediaStream';
import type { ReelPreloadState } from './reelPreload';

/** How the reel's bytes reach its element: streamed through MSE, or read whole first (and why). */
export type ReelSourceKind =
  | 'stream'
  | `whole (${Extract<SegmentedPlayback, { kind: 'blob' }>['reason']})`;

/** Names the source kind of a playback choice (`chooseSegmentedPlayback`). */
export function reelSourceKind(playback: SegmentedPlayback): ReelSourceKind {
  return playback.kind === 'stream' ? 'stream' : `whole (${playback.reason})`;
}

/** The element's state the line reports when no frame came. */
export type ReelViewElement = Pick<HTMLMediaElement, 'readyState' | 'networkState' | 'error'>;

/** The media gate's load at the end of the view: a reel queued behind three downloads says so. */
export interface ReelViewGate {
  inFlight: number;
  queued: number;
}

/** What is known when the reel becomes the one on screen. */
export interface ReelViewStart {
  postId: string;
  mediaId: string;
  source: ReelSourceKind;
  /** The ciphertext's size, from the ref. */
  size: number;
  /** The preload handed over at the swipe, or `none`. */
  preload: ReelPreloadState | 'none';
}

/** The `<video>` events a view records - each the first time only, except the two counters. */
export type ReelViewEvent =
  | 'loadstart'
  | 'loadedmetadata'
  | 'loadeddata'
  | 'playing'
  | 'waiting'
  | 'stalled';

/** Everything one view collected, as {@link describeReelView} reads it. */
export interface ReelViewFacts extends ReelViewStart {
  startedAt: number;
  /** The whole file is in the pool (`PostMedia`'s `onLoaded`). */
  downloadedAt?: number;
  /** The element began loading its source (`loadstart`). */
  sourceAt?: number;
  metadataAt?: number;
  /** The first frame is decoded (`loadeddata`). */
  firstFrameAt?: number;
  playingAt?: number;
  /** `waiting` while playing: the playhead ran out of data. */
  buffering: number;
  stalled: number;
  /** The typed download failure (`PostMedia`'s `onFailure`). */
  failure: string | null;
  /** Why it will not play by itself (`PostMedia`'s `onPlaybackBlocked`). */
  blocked: string | null;
  stream: StreamProgress | null;
  element: ReelViewElement | null;
}

/** One reel's view, from the moment it is on screen to the moment it leaves. */
export class ReelView {
  readonly facts: ReelViewFacts;
  readonly #now: () => number;

  /** @param now The clock that stamps events (`performance.now` by default; a test passes its own). */
  constructor(start: ReelViewStart, now: () => number = () => performance.now()) {
    this.#now = now;
    this.facts = {
      ...start,
      startedAt: now(),
      buffering: 0,
      stalled: 0,
      failure: null,
      blocked: null,
      stream: null,
      element: null,
    };
  }

  /**
   * Records one event of the reel's `<video>`.
   *
   * @param element The element that fired it - kept, so the end reads its last state.
   * @param stream  The stream feeding that element's source, when it is one (read at `loadstart`).
   */
  event(
    type: ReelViewEvent,
    element: ReelViewElement & { paused?: boolean },
    stream?: StreamProgress
  ): void {
    const f = this.facts;
    const at = this.#now();
    f.element = element;
    switch (type) {
      case 'loadstart':
        f.sourceAt ??= at;
        if (stream) f.stream = stream;
        return;
      case 'loadedmetadata':
        f.metadataAt ??= at;
        return;
      case 'loadeddata':
        f.firstFrameAt ??= at;
        return;
      case 'playing':
        f.playingAt ??= at;
        return;
      case 'waiting':
        if (!element.paused) f.buffering += 1;
        return;
      case 'stalled':
        f.stalled += 1;
        return;
    }
  }

  /** The whole file is in the pool. */
  downloaded(): void {
    this.facts.downloadedAt ??= this.#now();
  }

  /** The download failed, typed at the throw (`MediaFailureCause`). */
  failed(cause: string): void {
    this.facts.failure ??= cause;
  }

  /** The reel will not play by itself: an autoplay refused, bytes refused, a failed download. */
  wontPlay(cause: string): void {
    this.facts.blocked ??= cause;
  }

  /** Ends the view and returns its one line. */
  end(gate?: ReelViewGate): string {
    return describeReelView(this.facts, this.#now(), gate);
  }
}

/** Milliseconds, or seconds past ten of them, for a reader. */
function duration(ms: number): string {
  return ms < 10_000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Where a view that never showed its first frame stopped: the LAST stage its load reached, read
 * from the facts in the order the bytes travel.
 */
export function reelViewStoppedAt(f: ReelViewFacts): string {
  if (f.failure) return `download failed (${f.failure})`;
  if (f.metadataAt !== undefined) return 'metadata decoded, no frame';
  if (f.source === 'stream') {
    if (!f.stream) return 'stream never reached the element';
    if (f.stream.segmentCount === null) return 'waiting for the file header';
    if (f.stream.appended === 0) return 'header read, no segment appended';
    return 'segments appended, no metadata decoded';
  }
  if (f.sourceAt !== undefined) return 'file handed to the element, no metadata decoded';
  if (f.downloadedAt !== undefined) return 'file in, never handed to the element';
  return 'downloading the whole file';
}

/** The view's one line - see the file header. */
export function describeReelView(f: ReelViewFacts, endedAt: number, gate?: ReelViewGate): string {
  const watched = duration(endedAt - f.startedAt);
  const parts: string[] = [f.source];
  if (f.stream) {
    parts.push(
      `${f.stream.appended}/${f.stream.segmentCount ?? '?'} segment(s) ${megabytes(f.stream.bytes)}`
    );
  } else {
    parts.push(
      `${megabytes(f.size)} ${f.downloadedAt !== undefined ? `in after ${duration(f.downloadedAt - f.startedAt)}` : 'not in'}`
    );
  }
  parts.push(`preload ${f.preload}`);
  if (f.buffering > 0) parts.push(`${f.buffering} buffering`);
  if (f.stalled > 0) parts.push(`${f.stalled} stalled`);
  if (f.blocked) parts.push(`will not play by itself (${f.blocked})`);
  const head = `post ${f.postId} media ${f.mediaId}`;

  if (f.firstFrameAt !== undefined) {
    if (f.playingAt === undefined) parts.push('never playing');
    return `${head}: first frame in ${duration(f.firstFrameAt - f.startedAt)}, left after ${watched} - ${parts.join(', ')}`;
  }

  if (gate) parts.push(`media gate ${gate.inFlight} running ${gate.queued} queued`);
  if (f.element) {
    const code = f.element.error ? ` error ${f.element.error.code}` : '';
    parts.push(
      `element readyState ${f.element.readyState} networkState ${f.element.networkState}${code}`
    );
  }
  return `${head}: NO first frame, left after ${watched} - stopped at: ${reelViewStoppedAt(f)} - ${parts.join(', ')}`;
}
