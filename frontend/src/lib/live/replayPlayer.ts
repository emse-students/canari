/**
 * THE REPLAY PLAYER (docs/wiki/live-replays.md section 2, WP-R4): a finished live's own segments,
 * played from the START and seekable, through Media Source Extensions - the live player's pieces
 * (`livePlayer.ts`: the MSE flavour, the one-buffer settle, the init comparison; `liveCrypto.ts`: the
 * seal; `fmp4Segments.ts`: where an init ends) with a different clock. No manifest poll, no seat, no
 * live edge: the page of segments comes from `GET /api/lives/:id/replay`, and a bounded buffer is
 * kept AHEAD of the playhead and BEHIND it (the MSE quota on iOS).
 *
 * EVERY SEGMENT IS SELF-CONTAINED (its init, then one fragment), so a seek is the join logic at any
 * index: take the last segment whose `atMs` is at or before the target, append its init when it
 * differs from the last one appended, then its fragment. A camera re-acquired inside the live is a
 * new init; a background pause is a forward GAP in the media time that the engine's `waiting` seeks
 * over - both are the live player's, solved the same way.
 *
 * THE MEDIA TIME IS MEASURED, NEVER ASSUMED. The server's `atMs` is the arrival time on its clock,
 * the media time is the broadcaster's own timeline, and they drift by the upload's jitter. So each
 * appended segment's place is READ from the buffer (the new range it opened, `newMediaStart`) and
 * remembered in `placed`; the segment a seek targets is chosen by `atMs`, the playhead is put where
 * the buffer says it landed, and the segments to fetch next follow the `placed` places, never a
 * guess. A replay trimmed to its last three hours starts at a media time far from zero: the first
 * append is measured and, when it is past a second, redone under a `timestampOffset` that brings it
 * back to zero, so the player's bar (`duration`) reads the replay's own length.
 *
 * Every failure goes through {@link replayFailureOutcome}, ONE decision: a state to stop on, or a
 * retry with a backoff while the screen says "reconnecting". EVERYTHING OUTSIDE THIS FILE IS
 * INJECTED ({@link ReplayPlayerDeps}), so the machine is tested with fake MSE objects and a manual
 * clock: no sleep, no wall clock. Nothing here logs the key or a segment's bytes.
 */
import { fetchLiveReplay, fetchLiveSegment, isLiveRefusal, LiveRefusalError } from './api';
import { LiveSegmentOpenError, openLiveSegment } from './liveCrypto';
import { Fmp4ParseError, LastFrameHolds, initSegmentEnd } from './fmp4Segments';
import { LIVE_PLAYER_KEEP_BEHIND_MS } from './constants';
import {
  browserMediaSource,
  liveSourceBufferType,
  sameBytes,
  settleBuffer,
  type LiveMediaSourceKind,
  type LiveMediaSourceLike,
  type LiveSourceBufferLike,
  type LiveVideoLike,
} from './livePlayer';
import { liveRetryDelayMs } from './liveViewerState';
import { mediaStartsMs, measuredPositionAt, segmentPositionAt } from './replayTimeline';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type { LiveReplayPage, LiveReplaySegment } from './types';

/** The `SourceBuffer` of a replay: the live's, with the offset that brings a trimmed replay to zero. */
export interface ReplaySourceBufferLike extends LiveSourceBufferLike {
  timestampOffset: number;
}

/** The `MediaSource` of a replay: the live's, with the length the player's bar reads and the end. */
export interface ReplayMediaSourceLike extends LiveMediaSourceLike {
  duration: number;
  endOfStream(): void;
  addSourceBuffer(type: string): ReplaySourceBufferLike;
}

/** What the replay screen shows: the player's one state. */
export type ReplayState =
  | { kind: 'connecting' }
  | { kind: 'playing' }
  /** A transport failure or a busy server: the same step again after a backoff. */
  | { kind: 'reconnecting' }
  /** The replay is gone (expired, deleted, a block, a removal): the neutral "plus disponible" screen. */
  | { kind: 'gone' }
  | { kind: 'unavailable'; reason: 'unsupported' | 'undecryptable' | 'playback' | 'refused' };

/** Whether a state is final: the player has stopped and only the reader can start it again. */
export function isTerminalReplayState(state: ReplayState): boolean {
  return state.kind === 'gone' || state.kind === 'unavailable';
}

/**
 * What a failure means: a state to stop on, or `retry`. A `404` is the replay's end (an expired or
 * withheld replay is the same answer, by design); a transport failure and a busy server are retried;
 * anything else is a refusal or a defect of ours, never retried in a loop.
 */
export function replayFailureOutcome(error: unknown): { stop: ReplayState } | 'retry' {
  if (error instanceof LiveRefusalError) {
    switch (error.kind) {
      case 'not-found':
      case 'ended':
      case 'removed':
      case 'disabled':
        return { stop: { kind: 'gone' } };
      case 'seats-unavailable':
      case 'rate-limited':
      case 'unavailable':
      case 'retry-segment':
        return 'retry';
      default:
        return { stop: { kind: 'unavailable', reason: 'refused' } };
    }
  }
  if (isTransportFailure(error)) return 'retry';
  return { stop: { kind: 'unavailable', reason: 'refused' } };
}

/** A `[start, end)` span of buffered media, in seconds. */
export type MediaSpan = readonly [number, number];

/**
 * Where the media a buffer just took begins: the first piece of `after` that `before` did not hold
 * (a new range, or the tail an old range grew by), or `null` when nothing new appeared (the segment
 * was already there). The place of a segment is READ this way, never computed.
 */
export function newMediaStart(
  before: readonly MediaSpan[],
  after: readonly MediaSpan[]
): number | null {
  return newMediaExtent(before, after)?.[0] ?? null;
}

/**
 * The span the buffer just took: where it begins ({@link newMediaStart}) and where that new stretch
 * ends - at the next range the buffer already held, or at the end of the range it grew. Measured, so
 * the hole after a segment is known from the list whatever the buffer later forgets.
 */
function newMediaExtent(
  before: readonly MediaSpan[],
  after: readonly MediaSpan[]
): MediaSpan | null {
  const held = [...before].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of after) {
    // Sweep the old ranges across this one: `from` is the first instant none of them holds.
    let from = start;
    for (const [b0, b1] of held) {
      if (b1 <= from) continue;
      if (b0 > from + 0.05) break;
      from = Math.max(from, b1);
    }
    if (end - from > 0.05) {
      const bridged = held.find(([b0]) => b0 > from + 0.05 && b0 < end);
      return [from, bridged ? bridged[0] : end];
    }
  }
  return null;
}

/** The ranges of a buffer as plain spans. */
function spansOf(buffer: LiveSourceBufferLike): MediaSpan[] {
  const out: MediaSpan[] = [];
  const r = buffer.buffered;
  for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)]);
  return out;
}

/** The ONE tolerance of an edge: a position within it before a range's start is ON the range. */
const EDGE_TOL_S = 0.01;
/** A gap narrower than this is no hole (rounding of the engine's timestamps). */
const HOLE_MIN_S = 0.05;

/** Whether `at` is on `range`: from its start (less the tolerance) up to, never including, its end. */
function onRange(at: number, range: MediaSpan): boolean {
  return at >= range[0] - EDGE_TOL_S && at < range[1];
}

/**
 * THE HOLES OF THE REPLAY TIMELINE, known from the segment list rather than detected by a stall: where
 * a segment was MEASURED to end and its list neighbour to begin later, the gap is a hole the live itself
 * had (a camera flip, a background pause). Returned as `[from, to]` in media seconds. These are
 * "where a segment sits in media time" facts; what the SourceBuffer holds now is a separate matter.
 */
export function knownHoles(
  segments: readonly LiveReplaySegment[],
  placed: ReadonlyMap<number, number>,
  ends: ReadonlyMap<number, number>,
  skipped: { has(index: number): boolean } = new Set()
): MediaSpan[] {
  const holes: MediaSpan[] = [];
  // The leading gap: the first segment of the list begins after zero (the playhead starts at 0).
  // The first MEASURED segment, when only skipped ones precede it.
  let first: number | undefined;
  for (const { index } of segments) {
    const start = placed.get(index);
    if (start !== undefined) {
      first = start;
      break;
    }
    if (!skipped.has(index)) break;
  }
  if (first !== undefined && first > HOLE_MIN_S) holes.push([0, first]);
  // Each measured segment is paired with the NEXT measured one, a segment skipped for good (404, did not
  // open) being transparent: the media it would have held is a gap like any other. A region not loaded
  // yet (neither measured nor skipped) breaks the pairing: nothing is known across it.
  let prevEnd: number | undefined;
  for (const { index } of segments) {
    const start = placed.get(index);
    if (start === undefined) {
      if (!skipped.has(index)) prevEnd = undefined;
      continue;
    }
    if (prevEnd !== undefined && start >= prevEnd + HOLE_MIN_S) holes.push([prevEnd, start]);
    prevEnd = ends.get(index);
  }
  return holes;
}

/** What the player needs from outside: the network, the seal, the media source, a timer. */
export interface ReplayPlayerDeps {
  fetchReplay: typeof fetchLiveReplay;
  fetchSegment: typeof fetchLiveSegment;
  openSegment: typeof openLiveSegment;
  /** The engine's MSE flavour, or null when it has none. */
  mediaSource(): LiveMediaSourceKind | null;
  /** Points the video at the source; returns what undoes it (revoke the object URL). */
  attach(source: LiveMediaSourceLike): () => void;
  /** Runs `fn` after `ms`; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

/** Options of a {@link ReplayPlayer}. */
export interface ReplayPlayerOptions {
  liveId: string;
  video: LiveVideoLike;
  /** Told every state change. */
  onState(state: ReplayState): void;
  /** Told the first page's facts: the post, the length, and the expiry with the server's clock. */
  onMeta?(meta: { postId: string; durationMs: number; expiresAt: string; serverNow: string }): void;
  deps?: Partial<ReplayPlayerDeps> & Pick<ReplayPlayerDeps, 'attach'>;
}

/** Media kept buffered ahead of the playhead, in seconds. */
export const REPLAY_AHEAD_S = 12;
/** Media kept behind the playhead, in seconds (the live viewer's own bound). */
export const REPLAY_BEHIND_S = LIVE_PLAYER_KEEP_BEHIND_MS / 1000;
/** Media kept far ahead after a seek that left an older region buffered, in seconds. */
export const REPLAY_FAR_AHEAD_S = 60;
/**
 * How many segments in a row a seek's landing walk may find missing (404, skipped, no media) before it
 * gives up on that direction: about 45 s of replay at 1.5 s a segment. A run of deleted segments
 * longer than that is a purge, not a pause (a pause is a hole in TIME, kept by the segment list), so
 * the rest of the listing is the end of the walk for this seek. Bounds the requests a seek makes
 * waiting on the server (901 for a long tail of 404s without it).
 */
const REPLAY_MAX_MISSING_WALK = 30;
/** How many segments in a row may fail to open or append before the replay is called unplayable. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * A segment's own length, in seconds: the most a seek lands inside its segment, AND the tail of a
 * range - the last fragment - where a stopped playhead has run out of playable media at a hole's edge.
 * ONE constant for both. The 0.5 s stop was read on the Mi 9T only; it was never read on iOS.
 */
const REPLAY_SEGMENT_LENGTH_S = 1.5;
/** The most two measurements of one segment may differ by before it is said at warn, in seconds: one frame. */
const MEASURE_FRAME_S = 0.05;
/** How many times a seek looks its segment up again after the one taken proved not to hold the target. */
const REPLAY_SEEK_RELOOKUPS = 3;
/** A first append placed past this many seconds is redone under a `timestampOffset` to zero. */
const REBASE_THRESHOLD_S = 1;

const defaultDeps: Omit<ReplayPlayerDeps, 'attach'> = {
  fetchReplay: fetchLiveReplay,
  fetchSegment: fetchLiveSegment,
  openSegment: openLiveSegment,
  mediaSource: browserMediaSource,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * ONE USER SEEK: its id (the latest one is the single source of truth) and the signal that cancels
 * its downloads the moment a newer seek supersedes it.
 */
interface SeekTicket {
  readonly id: number;
  readonly signal: AbortSignal;
}

/** Thrown inside the player to stop on a state; never leaves it. */
class StopOn extends Error {
  constructor(readonly state: ReplayState) {
    super(`stop on ${state.kind}`);
  }
}

/** ONE PLAYER PER OPEN REPLAY. `start()` opens it, `stop()` gives everything back. */
export class ReplayPlayer {
  private readonly deps: ReplayPlayerDeps;
  private readonly liveId: string;
  private readonly video: LiveVideoLike;
  private readonly opts: ReplayPlayerOptions;

  /** Bumped by every start and stop: a continuation of an older run sees it changed and returns. */
  private generation = 0;
  private running = false;
  private cancelTimer: (() => void) | null = null;
  private downloads: AbortController | null = null;
  private detach: (() => void) | null = null;
  private source: ReplayMediaSourceLike | null = null;
  private buffer: ReplaySourceBufferLike | null = null;

  private keyHex: string | null = null;
  /** Every segment listed so far, ascending by index and by `atMs`. */
  private segments: LiveReplaySegment[] = [];
  private nextFrom: number | null = 0;
  /** The position in {@link segments} of the next segment to take. */
  private cursor = 0;
  /** The media time each appended segment was MEASURED to begin at, by segment index. */
  private placed = new Map<number, number>();
  /** The media time each appended segment was MEASURED to end at: kept with {@link placed} for the session. */
  private placedEnd = new Map<number, number>();
  /** Segments skipped for good (404, did not open): never a gap of the buffer to refill. */
  private skippedIdx = new Set<number>();
  /**
   * ONE range per probed purge, as segment indexes `[from, to)` (`to` is Infinity when the probe found no
   * media up to the end of the list): the positions between a run of really tried 404s and the first
   * existing segment after it, which the probe SAMPLED rather than read. A hole of the list for crossing,
   * and a sampled verdict - never an entry per presumed index.
   */
  private gaps: Array<[number, number]> = [];
  /** Sealed bytes a probe downloaded and the fill has not yet appended, by segment index (O(log n) of them). */
  private probed = new Map<number, ArrayBuffer>();
  /** What counts as no media: really tried and missing, or inside a probed gap. */
  private readonly missing = {
    has: (index: number): boolean => this.skippedIdx.has(index) || this.inGap(index),
  };
  private lastInit: Uint8Array | null = null;
  private retryAttempt = 0;
  private openFailures = 0;
  private appendFailures = 0;
  private skipped = 0;
  private appended = 0;
  /** The last video frames lengthened on append (the audio-ahead drift), for the summary. */
  private readonly holds = new LastFrameHolds();
  private seeks = 0;
  private state: ReplayState = { kind: 'connecting' };

  /** The serial queue: one buffer operation at a time, in order. */
  private tail: Promise<void> = Promise.resolve();
  /** A fill is queued: `timeupdate` asks for more media at most once at a time. */
  private fillQueued = false;
  /** A seek is waiting its turn: the running fill yields so the seek is not made to wait for 12 s of media. */
  private seekPending = false;
  /** The id of the LATEST seek: an older one that completes finds it changed and moves nothing. */
  private seekId = 0;
  /** Cancels the downloads of the latest seek when the next one supersedes it. */
  private seekAbort: AbortController | null = null;

  constructor(opts: ReplayPlayerOptions) {
    this.opts = opts;
    this.liveId = opts.liveId;
    this.video = opts.video;
    this.deps = { ...defaultDeps, ...opts.deps } as ReplayPlayerDeps;
  }

  /** The state on screen now. */
  get current(): ReplayState {
    return this.state;
  }

  /** Opens the replay: the first page and the key, the source, then the first media. */
  start(): void {
    console.debug(`[LIVE_REPLAY] player start ${this.liveId}`);
    this.teardownMedia();
    const gen = ++this.generation;
    this.downloads = new AbortController();
    this.reset();
    this.running = true;
    this.state = { kind: 'connecting' };
    this.opts.onState(this.state);
    this.enqueue(gen, () => this.open(gen));
  }

  /** The reader asked again (the "indisponible" screen's button). */
  retry(): void {
    console.debug(`[LIVE_REPLAY] player retry ${this.liveId} from ${this.state.kind}`);
    this.start();
  }

  /** Closes the player: every timer, download and the source go. */
  stop(): void {
    console.debug(`[LIVE_REPLAY] player stop ${this.liveId} (${this.state.kind})`);
    this.generation++;
    this.running = false;
    this.summarise('stopped');
    this.teardownMedia();
  }

  /**
   * The `<video>` moved (`timeupdate`): more media is fetched when the playhead's lead has fallen under
   * {@link REPLAY_AHEAD_S}, and what lies far behind or far ahead is dropped. One fill at a time.
   */
  noteTime(): void {
    if (!this.running || !this.buffer) return;
    this.crossHole(false);
    if (this.fillQueued) return;
    this.fillQueued = true;
    const gen = this.generation;
    this.enqueue(gen, async () => {
      this.fillQueued = false;
      await this.trim(gen);
      await this.fill(gen);
    });
  }

  /**
   * The `<video>` is seeking (the bar was dragged, a loop went back to 0): when the target is in a
   * buffered range the playhead is already where it should be and only the next segment to fetch
   * follows that range; otherwise the target's segment is taken and the playhead put where the buffer
   * says it landed.
   */
  noteSeeking(): void {
    if (!this.running || !this.buffer) return;
    const gen = this.generation;
    const at = this.video.currentTime;
    this.seekPending = true;
    // The latest target wins: the older seek's download is cancelled and its queued step is void.
    this.seekAbort?.abort();
    const abort = new AbortController();
    this.seekAbort = abort;
    const ticket: SeekTicket = { id: ++this.seekId, signal: abort.signal };
    this.enqueue(gen, async () => {
      if (this.isStale(ticket)) {
        console.debug(`[LIVE_REPLAY] seek ${ticket.id} to ${at.toFixed(2)} superseded - dropped`);
        this.endReconnecting();
        return;
      }
      this.seekPending = false;
      // A target INSIDE a hole lands on the start of the media after it: nothing plays there.
      const hole = this.holeAt(at, false);
      const target = hole ? hole[1] : at;
      if (hole) {
        console.debug(
          `[LIVE_REPLAY] seek to ${at.toFixed(2)} is in a hole - landing on ${target.toFixed(2)}`
        );
        this.video.currentTime = target;
      }
      const span = spansOf(this.buffer as ReplaySourceBufferLike).find((r) => onRange(target, r));
      if (span) {
        this.cursor = this.cursorAfter(span);
        // The older seek's retry (if any) is void: the playhead is on media, nothing is being waited for.
        this.endReconnecting();
        console.debug(
          `[LIVE_REPLAY] seek to ${at.toFixed(2)}: buffered, next segment ${this.cursor}`
        );
      } else {
        await this.seekTo(gen, target * 1000, ticket);
      }
      await this.fill(gen);
    });
  }

  /**
   * The `<video>` fired `waiting`: a playhead on a hole - a seek's engine wait, a gap the cursor
   * jumped, a background pause of the live - is put on the segment that covers it. A wait inside
   * buffered media is the engine's own and is left to end by itself.
   */
  noteStall(): void {
    if (!this.running || !this.buffer || this.video.seeking) return;
    const at = this.video.currentTime;
    const spans = spansOf(this.buffer);
    if (this.crossHole(true)) return;
    if (spans.some(([s, e]) => onRange(at, [s, e - HOLE_MIN_S]))) return;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: waiting on a hole at ${at.toFixed(2)} - re-anchoring`
    );
    this.noteSeeking();
  }

  /**
   * Crosses a KNOWN hole by construction: a playhead in a hole, or at its start, is put on the start
   * of the media after it. When the engine is `stalled`, a playhead whose CURRENT range ends at a hole
   * with at most {@link REPLAY_SEGMENT_LENGTH_S} of media left is carried over too - never one with
   * more left, which would skip content still ahead. No timer. Returns whether it moved.
   */
  private crossHole(stalled: boolean): boolean {
    if (!this.buffer || this.video.seeking) return false;
    const at = this.video.currentTime;
    const hole = this.holeAt(at, stalled);
    if (!hole) return false;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: at ${at.toFixed(2)} the hole ${hole[0].toFixed(2)}-${hole[1].toFixed(2)} - crossed`
    );
    this.video.currentTime = hole[1];
    return true;
  }

  /**
   * The known hole `at` is in; with `stalled`, also the one ending the CURRENT range when at most
   * {@link REPLAY_SEGMENT_LENGTH_S} of that range is left. A hole is `[from, to - tolerance)`, a range
   * `[start - tolerance, end)`: the two never overlap, so a landing is never both.
   */
  private holeAt(at: number, stalled: boolean): MediaSpan | null {
    if (!this.buffer) return null;
    const spans = spansOf(this.buffer);
    const holes = knownHoles(this.segments, this.placed, this.placedEnd, this.missing);
    const inside = holes.find(([from, to]) => at >= from && at < to - EDGE_TOL_S);
    if (inside || !stalled) return inside ?? null;
    const range = spans.find((r) => onRange(at, r));
    if (!range || range[1] - at > REPLAY_SEGMENT_LENGTH_S) return null;
    return holes.find(([from]) => Math.abs(from - range[1]) < HOLE_MIN_S) ?? null;
  }

  /** The `<video>` reported an `error`: nothing more will play from this source. */
  noteMediaError(): void {
    if (!this.running) return;
    console.error(`[LIVE_REPLAY] ${this.liveId}: the video reported an error`);
    this.fail(
      this.generation,
      new StopOn({ kind: 'unavailable', reason: 'playback' }),
      async () => {}
    );
  }

  // ------------------------------------------------------------------------------------------

  private reset(): void {
    this.keyHex = null;
    this.segments = [];
    this.nextFrom = 0;
    this.cursor = 0;
    this.placed = new Map();
    this.placedEnd = new Map();
    this.skippedIdx = new Set();
    this.gaps = [];
    this.probed = new Map();
    this.lastInit = null;
    this.retryAttempt = 0;
    this.openFailures = 0;
    this.appendFailures = 0;
    this.skipped = 0;
    this.appended = 0;
    this.holds.reset();
    this.seeks = 0;
    this.tail = Promise.resolve();
    this.fillQueued = false;
    this.seekPending = false;
    this.seekAbort?.abort();
    this.seekAbort = null;
  }

  /** Any server answer (bytes or a 404) proves reachability: the reconnecting screen ends, the backoff restarts. */
  private answered(): void {
    this.retryAttempt = 0;
    if (this.state.kind === 'reconnecting') this.setState({ kind: 'playing' });
  }

  /** A seek that no longer waits on the network ends the reconnecting screen of an older one's retry. */
  private endReconnecting(): void {
    if (this.state.kind !== 'reconnecting') return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.setState({ kind: 'playing' });
  }

  /** Whether a newer seek has replaced `ticket`: its results must not touch the playhead. */
  private isStale(ticket: SeekTicket): boolean {
    return ticket.id !== this.seekId;
  }

  private alive(gen: number): boolean {
    return gen === this.generation && this.running;
  }

  private setState(next: ReplayState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId} -> ${next.kind}${'reason' in next ? ` (${next.reason})` : ''}`
    );
    this.opts.onState(next);
  }

  private teardownMedia(): void {
    this.seekAbort?.abort();
    this.seekAbort = null;
    this.downloads?.abort();
    this.downloads = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.detach?.();
    this.detach = null;
    this.source = null;
    this.buffer = null;
  }

  /** Runs `fn` after the queued work; every failure of it is decided once, by {@link fail}. */
  private enqueue(gen: number, fn: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.alive(gen)) return;
      try {
        await fn();
      } catch (e) {
        this.fail(gen, e, fn);
      }
    });
    this.tail = run;
    return run;
  }

  /** Every failure of a step, decided once: stop on a state, or retry `step` after a backoff. */
  private fail(gen: number, error: unknown, step: () => Promise<void>): void {
    if (!this.alive(gen)) return;
    const outcome = error instanceof StopOn ? { stop: error.state } : replayFailureOutcome(error);
    if (outcome === 'retry') {
      this.retryAttempt++;
      const wait = liveRetryDelayMs(this.retryAttempt);
      console.warn(
        `[LIVE_REPLAY] ${this.liveId}: no answer or busy (${describe(error)}), retry ${this.retryAttempt} in ${wait} ms`
      );
      this.setState({ kind: 'reconnecting' });
      this.cancelTimer?.();
      this.cancelTimer = this.deps.schedule(() => {
        this.cancelTimer = null;
        this.enqueue(gen, step);
      }, wait);
      return;
    }
    const final = outcome.stop;
    if (final.kind === 'unavailable' && !(error instanceof StopOn)) {
      console.error(`[LIVE_REPLAY] ${this.liveId}: stopped (${describe(error)})`, error);
    } else {
      console.warn(`[LIVE_REPLAY] ${this.liveId}: stopped on ${final.kind} (${describe(error)})`);
    }
    this.generation++;
    this.running = false;
    this.summarise(final.kind);
    this.downloads?.abort();
    this.downloads = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.video.pause();
    this.setState(final);
  }

  /** The source and its one buffer, then the first page, then the first media. */
  private async open(gen: number): Promise<void> {
    if (!this.buffer) await this.openSource(gen);
    if (!this.alive(gen)) return;
    if (this.keyHex === null) await this.loadPage(gen);
    if (!this.alive(gen)) return;
    this.retryAttempt = 0;
    await this.fill(gen);
    if (!this.alive(gen)) return;
    this.resume();
    this.setState({ kind: 'playing' });
  }

  private async openSource(gen: number): Promise<void> {
    const kind = this.deps.mediaSource();
    const type = liveSourceBufferType();
    if (!kind || !kind.isTypeSupported(type)) {
      console.warn(
        `[LIVE_REPLAY] ${kind ? `${kind.name} cannot play ${type}` : 'no MediaSource on this engine'}`
      );
      throw new StopOn({ kind: 'unavailable', reason: 'unsupported' });
    }
    const source = kind.create() as ReplayMediaSourceLike;
    this.source = source;
    this.detach = this.deps.attach(source);
    if (source.readyState !== 'open') {
      await new Promise<void>((resolve) =>
        source.addEventListener('sourceopen', () => resolve(), { once: true })
      );
    }
    if (!this.alive(gen) || this.source !== source) return;
    const buffer = source.addSourceBuffer(type);
    buffer.mode = 'segments';
    this.buffer = buffer;
    console.debug(`[LIVE_REPLAY] source open (${kind.name}, ${type})`);
  }

  /** The next page of the list; the first one also brings the key and the facts. */
  private async loadPage(gen: number): Promise<void> {
    const from = this.nextFrom;
    if (from === null) return;
    const page: LiveReplayPage = await this.deps.fetchReplay(
      this.liveId,
      from === 0 ? undefined : from
    );
    if (!this.alive(gen)) return;
    if (this.keyHex === null) {
      this.keyHex = page.key;
      this.opts.onMeta?.({
        postId: page.postId,
        durationMs: page.durationMs,
        expiresAt: page.expiresAt,
        serverNow: page.serverNow,
      });
      // The bar reads the replay's own length from the first frame, before any media is in.
      if (this.source && page.durationMs > 0) this.source.duration = page.durationMs / 1000;
    }
    const before = this.segments.length;
    this.segments.push(
      ...page.segments.filter((s) => s.index >= (this.segments.at(-1)?.index ?? -1) + 1)
    );
    this.nextFrom = page.nextFrom;
    // PAGING TERMINATES BY PROOF, never by trusting the server: every paging loop calls this one step,
    // and a page that added nothing, or whose cursor did not move forward, ends the listing - otherwise
    // such an answer would be requested forever.
    if (page.nextFrom !== null && (this.segments.length === before || page.nextFrom <= from)) {
      console.warn(
        `[LIVE_REPLAY] ${this.liveId}: the server answered a page from ${from} that added ${this.segments.length - before} segments with nextFrom ${page.nextFrom} - the listing is declared complete at ${this.segments.length} segments`
      );
      this.nextFrom = null;
    }
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: ${this.segments.length} segments listed${this.nextFrom === null ? ' (all)' : ''}`
    );
  }

  /** Lists pages until a segment at or past `ms` is known, or the list is whole. */
  private async listUntil(gen: number, ms: number): Promise<void> {
    while (
      this.alive(gen) &&
      this.nextFrom !== null &&
      (mediaStartsMs(this.segments, this.placed).at(-1) ?? -1) < ms
    ) {
      await this.loadPage(gen);
    }
  }

  /**
   * Keeps {@link REPLAY_AHEAD_S} of media ahead of the playhead, taking segments from the cursor; at
   * the end of the list it declares the end of the stream. Yields to a waiting seek.
   */
  private async fill(gen: number): Promise<void> {
    this.cursor = Math.min(this.cursor, this.firstGapAhead());
    let missing = 0;
    while (this.alive(gen) && !this.seekPending) {
      if (this.cursor >= this.segments.length) {
        if (this.nextFrom !== null) {
          await this.loadPage(gen);
          continue;
        }
        this.endOfFill(gen);
        return;
      }
      if (this.mediaAhead() >= REPLAY_AHEAD_S) return;
      const s = this.segments[this.cursor];
      this.cursor++;
      if (this.isBuffered(s.index) || this.missing.has(s.index)) continue;
      // The bytes a probe already downloaded for this segment are appended, not fetched again.
      const pre = this.probed.get(s.index);
      this.probed.delete(s.index);
      await this.take(gen, s, undefined, pre);
      // The fill's own walk over a purge is bounded like a seek's: this many requested 404s in a row
      // and the walk is replaced by a probe forward (doubling stride, then bisection) to the FIRST
      // existing segment after the gap; the fill goes on from there. The stream's end is declared only
      // when the probe reaches the end of the list - never inside a purge.
      missing = this.skippedIdx.has(s.index) ? missing + 1 : 0;
      if (missing >= REPLAY_MAX_MISSING_WALK) {
        console.warn(
          `[LIVE_REPLAY] ${this.liveId}: ${missing} segments in a row missing at position ${this.cursor} - probing ahead`
        );
        // The bytes of EVERY segment the probe finds (the bisection's hits too) are kept by segment index:
        // the fill appends each from them when it reaches it, never fetching one twice.
        const kept = this.probed;
        const found = await this.probeGap(gen, this.cursor, 1, async (pos) => {
          // A newer seek must not wait for the probe: it is redone by a later fill.
          if (this.seekPending || !this.alive(gen)) return 'stale';
          const seg = this.segments[pos];
          if (this.skippedIdx.has(seg.index)) return false;
          const sealed = await this.download(gen, seg);
          if (!this.alive(gen) || this.seekPending) return 'stale';
          if (sealed !== null) kept.set(seg.index, sealed);
          return sealed !== null;
        });
        if (found === 'stale') return;
        // ONE gap per purge: from the next unvisited segment to the first existing one (or to the end).
        const upto = found ?? this.segments.length;
        this.gaps.push([
          this.segments[this.cursor].index,
          found === undefined ? Number.POSITIVE_INFINITY : this.segments[found].index,
        ]);
        this.cursor = upto;
        if (found !== undefined) {
          const sealed = kept.get(this.segments[found].index);
          kept.delete(this.segments[found].index);
          if (sealed !== undefined) {
            this.cursor = found + 1;
            await this.take(gen, this.segments[found], undefined, sealed);
          }
        }
        missing = 0;
      }
    }
  }

  /**
   * The position in the list of the first segment at or after the playhead's own that the buffer does
   * not hold (and that was not skipped for good): the fill's cursor never stays past it, so media the
   * buffer dropped ahead of the playhead is fetched again, keyed on the MEASURED places. The list's
   * length when everything from the playhead on is held; the cursor's own value when nothing is
   * measured yet.
   */
  private firstGapAhead(): number {
    if (!this.buffer) return this.cursor;
    const at = this.video.currentTime;
    const hole = this.holeAt(at, false);
    const from = hole ? hole[1] : at;
    let k0 = -1;
    for (let k = 0; k < this.segments.length; k++) {
      const p = this.placed.get(this.segments[k].index);
      if (p !== undefined && p <= from + EDGE_TOL_S) k0 = k;
    }
    if (k0 < 0) return this.cursor;
    // The last measured segment before the playhead counts only when it reaches it; otherwise the
    // playhead is past an unmeasured stretch and its own place in the list is the start: nothing is
    // fetched behind it.
    const reach = this.placedEnd.get(this.segments[k0].index);
    if (reach === undefined || reach < from - EDGE_TOL_S) {
      k0 = Math.max(k0 + 1, segmentPositionAt(this.segments, from * 1000, this.placed));
    }
    const spans = spansOf(this.buffer);
    for (let k = k0; k < this.segments.length; k++) {
      const { index } = this.segments[k];
      if (this.missing.has(index)) continue;
      const start = this.placed.get(index);
      const held =
        start !== undefined && spans.some(([a, b]) => start >= a - EDGE_TOL_S && start + 0.5 < b);
      if (!held) return k;
    }
    return this.segments.length;
  }

  /** Whether segment `index` lies inside a probed gap. */
  private inGap(index: number): boolean {
    return this.gaps.some(([from, to]) => index >= from && index < to);
  }

  /**
   * The fill has nothing more to take. A replay in which NO segment ever gave media has no end to show
   * and nothing to play: it stops on `gone` (the neutral "plus disponible" screen), never on a black
   * picture with a spinner. Otherwise the end of the stream is declared.
   */
  private endOfFill(gen: number): void {
    if (this.noMediaAtAll()) {
      console.warn(
        `[LIVE_REPLAY] ${this.liveId}: the probes found no media in the whole list - gone`
      );
      throw new StopOn({ kind: 'gone' });
    }
    // A probed gap running to the end of the list was judged EMPTY by the same sampled rule as `gone`:
    // the stream ends after the last placed media (the duration follows it, see `declareEnd`).
    this.declareEnd(gen);
  }

  /**
   * THE SAMPLED VERDICT FOR `gone`: nothing was ever appended, the list is complete, and every segment was
   * either really tried and missing or lies in a probed gap - the probes found nothing across the whole
   * list. The server releases a replay's segments whole, when its post is deleted (`LivesService.purgeEnded`
   * in apps/social-service/src/lives/lives.service.ts: the folder goes with the live row), so a sampled
   * "nothing" is a sound verdict; walking every segment of it under a spinner (2000 requests) is not.
   */
  private noMediaAtAll(): boolean {
    return (
      this.appended === 0 &&
      this.nextFrom === null &&
      this.segments.length > 0 &&
      this.segments.every((x) => this.missing.has(x.index))
    );
  }

  /**
   * The last segment is in: the stream ends, and the engine's `ended` closes the picture.
   *
   * THE ENGINE'S OWN STATE IS THE ONLY MEMORY OF "ended" (measured on desktop Chrome, S12): the
   * specification reopens an ended source to `open` on ANY `appendBuffer` or `remove`, and an open
   * source waits for more data forever - the playhead then halts before the last frame with a
   * spinner. A flag kept here would stay true after the trim behind the playhead (or a refill of a
   * gap) reopened it. So this runs at every arrival at the end of the list and declares whenever the
   * source is open: idempotent through `readyState`, never through a flag of ours.
   */
  private declareEnd(gen: number): void {
    const source = this.source;
    if (!source || !this.alive(gen) || source.readyState !== 'open') return;
    if (this.buffer?.updating) return;
    try {
      // No `duration` write: `endOfStream` sets it to the largest buffered end, and a write below a buffered
      // frame's start (the audio ending after the video) throws before the end is ever declared.
      source.endOfStream();
      console.debug(
        `[LIVE_REPLAY] ${this.liveId}: end of stream declared at ${this.cursor} segments`
      );
    } catch (e) {
      console.warn(`[LIVE_REPLAY] ${this.liveId}: endOfStream refused (${String(e)})`);
    }
  }

  /**
   * Media buffered ahead of the playhead, in seconds, counted ACROSS the known holes (the leading gap
   * included): a hole opens a new range, and a lead that stopped at it would never be met, so the fill
   * would download the whole replay. 0 when nothing is buffered where the playhead stands.
   */
  private mediaAhead(): number {
    if (!this.buffer) return 0;
    return this.walkAhead(this.video.currentTime, Number.POSITIVE_INFINITY).media;
  }

  /**
   * The media time where the walk ahead of `at` stops: after `media` buffered seconds, or where the
   * buffer runs out - never `at` itself. Everything the walk passed (a known hole included) is
   * reachable, so the trim must not drop it: with less than `media` seconds buffered, falling back to
   * `at` made the media just after a long pause "far" and it was removed and fetched again on every
   * timeupdate.
   */
  private positionAhead(at: number, media: number): number {
    return this.walkAhead(at, media).position;
  }

  /**
   * Walks the buffer from `at`: through a range to its end, over a known hole to the media after it,
   * until `limit` seconds of media are counted or nothing is buffered. Returns the media counted and
   * where the walk stopped.
   */
  private walkAhead(at: number, limit: number): { media: number; position: number } {
    if (!this.buffer) return { media: 0, position: at };
    const spans = spansOf(this.buffer);
    const holes = knownHoles(this.segments, this.placed, this.placedEnd, this.missing);
    let pos = at;
    let media = 0;
    for (let guard = 0; guard <= holes.length + 1 && media < limit; guard++) {
      const hole = holes.find(([from, to]) => pos >= from - HOLE_MIN_S && pos < to - EDGE_TOL_S);
      if (hole) pos = hole[1];
      const range = spans.find((r) => onRange(pos, r));
      if (!range) break;
      const take = Math.min(range[1] - pos, limit - media);
      media += take;
      pos += take;
    }
    return { media, position: pos };
  }

  /** Whether segment `index` is already buffered where it was placed. */
  private isBuffered(index: number): boolean {
    const start = this.placed.get(index);
    if (start === undefined || !this.buffer) return false;
    return spansOf(this.buffer).some(([s, e]) => start >= s - 0.01 && start + 0.5 < e);
  }

  /** The cursor after the buffered `span`: one past the last segment MEASURED inside it. */
  private cursorAfter(span: MediaSpan): number {
    let last = -1;
    for (const [index, start] of this.placed) {
      if (start >= span[0] - 0.01 && start < span[1] && index > last) last = index;
    }
    if (last >= 0) {
      const pos = this.segments.findIndex((s) => s.index === last);
      if (pos >= 0) return pos + 1;
    }
    return Math.max(0, segmentPositionAt(this.segments, span[1] * 1000, this.placed)) + 1;
  }

  /**
   * The position of the segment a media-time target `ms` falls in: the one whose MEASURED extent holds it
   * when there is one, else the estimate of {@link segmentPositionAt}.
   */
  private lookup(ms: number): number {
    const measured = measuredPositionAt(this.segments, this.placed, this.placedEnd, ms / 1000);
    return measured >= 0 ? measured : segmentPositionAt(this.segments, ms, this.placed);
  }

  /**
   * A seek to `ms` of the replay: the target's segment is taken and the playhead put where it landed.
   * Only the LATEST seek (`ticket`) may write the playhead: whatever an older one fetched is dropped.
   */
  private async seekTo(gen: number, ms: number, ticket: SeekTicket): Promise<void> {
    await this.listUntil(gen, ms);
    if (!this.alive(gen) || this.isStale(ticket)) return;
    let pos = this.lookup(ms);
    if (pos < 0) return;
    let s = this.segments[pos];
    this.seeks++;
    let heldStart = this.bufferedStart(s.index);
    let taken =
      heldStart !== undefined || this.skippedIdx.has(s.index)
        ? null
        : await this.take(gen, s, ticket);
    // THE LOOKUP IS AN ESTIMATE past the last measured segment: once the segment is taken its measured
    // extent says whether the target is really inside it. If not, look up again with the new measurement
    // - at most REPLAY_SEEK_RELOOKUPS times (a count, never a clock), and only while it picks another one.
    const visited = new Set<number>([pos]);
    for (let again = 0; again < REPLAY_SEEK_RELOOKUPS; again++) {
      if (!this.alive(gen) || this.isStale(ticket)) break;
      const from = this.placed.get(s.index);
      const to = this.placedEnd.get(s.index);
      const at = ms / 1000;
      if (from === undefined || to === undefined || (at >= from - EDGE_TOL_S && at < to)) break;
      const next = this.lookup(ms);
      // A segment already visited is never looked at again (no A -> B -> A).
      if (next < 0 || visited.has(next)) break;
      visited.add(next);
      console.debug(
        `[LIVE_REPLAY] ${this.liveId}: seek ${Math.round(ms)} ms missed segment ${s.index} (${from.toFixed(2)}-${to.toFixed(2)} s) - looking up again`
      );
      pos = next;
      s = this.segments[pos];
      heldStart = this.bufferedStart(s.index);
      taken =
        heldStart !== undefined || this.skippedIdx.has(s.index)
          ? null
          : await this.take(gen, s, ticket);
    }
    if (!this.alive(gen)) return;
    if (this.isStale(ticket)) {
      console.debug(
        `[LIVE_REPLAY] ${this.liveId}: seek ${ticket.id} (segment ${s.index}) superseded by ${this.seekId} - playhead untouched`
      );
      return;
    }
    this.cursor = pos + 1;
    // `take` says null for a segment skipped (404, open failure) AND for one already buffered: the
    // measured place of a buffered one is as good as a fresh one.
    let start = taken ?? this.bufferedStart(s.index);
    let landing: number | undefined;
    if (start !== undefined) {
      // The target's media time, held inside the segment: not before its start, not past its length.
      landing = Math.min(Math.max(start, ms / 1000), start + REPLAY_SEGMENT_LENGTH_S);
      const range = this.rangeOf(start);
      if (range && landing >= range[1] - HOLE_MIN_S) {
        // The target is past the segment's own end - in a hole of the live: land on the media after it.
        const after = await this.landForward(gen, pos + 1, ticket);
        if (after === 'stale') return;
        if (after) {
          landing = after.start;
          this.cursor = after.pos + 1;
        } else {
          landing = start; // no media after the hole to land on
        }
      }
    } else {
      // The target's own segment is skipped for good: the first media after it that exists, else the
      // last media held before it. A user seek is NEVER left unanswered (the engine would hang in
      // `seeking`, which also blocks the hole crossing).
      const after = await this.landForward(gen, pos + 1, ticket);
      if (after === 'stale') return;
      if (after) {
        start = landing = after.start;
        this.cursor = after.pos + 1;
      } else {
        // Nothing after: the LAST EXISTING segment before the target, never an arbitrary held range.
        const before = await this.landBackward(gen, pos - 1, ticket);
        if (before === 'stale') return;
        if (before) {
          start = landing = before.start;
          this.cursor = before.pos + 1;
        }
      }
    }
    // THE RULE: only a position INSIDE a range is ever written.
    if (landing !== undefined && !this.rangeOf(landing)) {
      landing = start !== undefined && this.rangeOf(start) ? start : undefined;
    }
    if (landing !== undefined) this.video.currentTime = landing;
    else {
      console.error(
        `[LIVE_REPLAY] ${this.liveId}: seek ${Math.round(ms)} ms - no media at all to land on`
      );
      if (this.noMediaAtAll()) throw new StopOn({ kind: 'gone' });
    }
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: seek to ${Math.round(ms)} ms -> segment ${s.index}`
    );
    this.resume();
  }

  /** The measured start of segment `index` when the buffer still holds it, else undefined. */
  private bufferedStart(index: number): number | undefined {
    return this.isBuffered(index) ? this.placed.get(index) : undefined;
  }

  /** The buffered range holding `at`, if any. */
  private rangeOf(at: number): MediaSpan | undefined {
    return this.buffer ? spansOf(this.buffer).find((r) => onRange(at, r)) : undefined;
  }

  /** The first segment from list position `from` on that gives media to land on, with its place. */
  private async landForward(
    gen: number,
    from: number,
    ticket: SeekTicket
  ): Promise<{ start: number; pos: number } | undefined | 'stale'> {
    let missing = 0;
    for (let j = from; ; j++) {
      if (missing >= REPLAY_MAX_MISSING_WALK) {
        console.warn(
          `[LIVE_REPLAY] ${this.liveId}: ${missing} segments in a row missing after position ${from} - the walk forward ends`
        );
        return undefined;
      }
      // The list is paged: the next segment may be on a page not listed yet.
      while (j >= this.segments.length && this.nextFrom !== null) {
        await this.loadPage(gen);
        if (!this.alive(gen) || this.isStale(ticket)) return 'stale';
      }
      if (j >= this.segments.length) return undefined;
      const costs = this.costsARequest(this.segments[j].index);
      const start = await this.landOn(gen, this.segments[j], ticket);
      if (start === 'stale') return 'stale';
      if (start !== undefined) return { start, pos: j };
      if (costs) missing++;
    }
  }

  /** The nearest segment BEFORE list position `from` that gives media to land on (walking backwards). */
  private async landBackward(
    gen: number,
    from: number,
    ticket: SeekTicket
  ): Promise<{ start: number; pos: number } | undefined | 'stale'> {
    let missing = 0;
    for (let k = from; k >= 0; k--) {
      if (missing >= REPLAY_MAX_MISSING_WALK) {
        console.warn(
          `[LIVE_REPLAY] ${this.liveId}: ${missing} segments in a row missing before position ${from} - probing further back`
        );
        return this.probeBackward(gen, k, ticket);
      }
      const costs = this.costsARequest(this.segments[k].index);
      const start = await this.landOn(gen, this.segments[k], ticket);
      if (start === 'stale') return 'stale';
      if (start !== undefined) return { start, pos: k };
      if (costs) missing++;
    }
    return undefined;
  }

  /** Whether answering for segment `index` takes a request: not held, not known skipped. */
  private costsARequest(index: number): boolean {
    return this.bufferedStart(index) === undefined && !this.skippedIdx.has(index);
  }

  /**
   * A purge too long to walk: starting at list position `from` (the segments just before it, in
   * direction `dir`, are missing), probe at a doubling stride (30, 60, 120, ... segments), one segment
   * each, down to the list's edge; the first probe that finds media is bisected against the previous
   * (missing) probe. O(log n) requests; returns the position of the existing segment nearest the gap
   * (the last before it going back, the first after it going forward), `undefined` when the edge is
   * reached with no media (going forward, the listing is paged to its end first).
   */
  private async probeGap(
    gen: number,
    from: number,
    dir: 1 | -1,
    exists: (pos: number) => Promise<boolean | 'stale'>
  ): Promise<number | undefined | 'stale'> {
    let missing = from - dir; // the last position known missing
    let stride = REPLAY_MAX_MISSING_WALK;
    for (;;) {
      let p = from + dir * stride;
      if (dir > 0) {
        while (p >= this.segments.length && this.nextFrom !== null) {
          await this.loadPage(gen);
          if (!this.alive(gen)) return 'stale';
        }
        p = Math.min(p, this.segments.length - 1);
        if (p < from) return undefined;
      } else {
        p = Math.max(0, p);
      }
      const here = await exists(p);
      if (here === 'stale') return 'stale';
      if (here) {
        let found = p;
        while (Math.abs(found - missing) > 1) {
          const mid = (found + missing) >> 1;
          const hit = await exists(mid);
          if (hit === 'stale') return 'stale';
          if (hit) found = mid;
          else missing = mid;
        }
        return found;
      }
      missing = p;
      const edge = dir > 0 ? p >= this.segments.length - 1 && this.nextFrom === null : p === 0;
      if (edge) return undefined;
      stride *= 2;
    }
  }

  /** A purge in front of a seek's landing: the last existing segment before the PROBED gap, with its place. */
  private async probeBackward(
    gen: number,
    k: number,
    ticket: SeekTicket
  ): Promise<{ start: number; pos: number } | undefined | 'stale'> {
    const pos = await this.probeGap(gen, k, -1, async (at) => {
      const r = await this.landOn(gen, this.segments[at], ticket);
      return r === 'stale' ? 'stale' : r !== undefined;
    });
    if (pos === 'stale' || pos === undefined) return pos;
    const start = await this.landOn(gen, this.segments[pos], ticket); // held by the probe: free
    return start === 'stale' || start === undefined ? undefined : { start, pos };
  }

  /** Takes `segment` and answers where it begins (fresh or already held), undefined when it gave none. */
  private async landOn(
    gen: number,
    segment: LiveReplaySegment,
    ticket: SeekTicket
  ): Promise<number | undefined | 'stale'> {
    // Held or skipped segments are answered from what is known, never downloaded again.
    const held = this.bufferedStart(segment.index);
    if (held !== undefined) return held;
    if (this.skippedIdx.has(segment.index)) return undefined;
    const taken = await this.take(gen, segment, ticket);
    if (!this.alive(gen) || this.isStale(ticket)) return 'stale';
    return taken ?? this.bufferedStart(segment.index);
  }

  /**
   * Downloads the sealed bytes of one segment: null when the segment is skipped (`404`), when the
   * player is gone, or when the seek that asked for it was superseded. Every download goes through
   * here, the retry of an open failure included.
   */
  private async download(
    gen: number,
    s: LiveReplaySegment,
    ticket?: SeekTicket
  ): Promise<ArrayBuffer | null> {
    // A seek's download has its own controller (no AbortSignal.any: absent before iOS 17.4 / Chrome 116);
    // `teardownMedia` aborts it with the rest, so it needs no chaining.
    const signal = ticket ? ticket.signal : this.downloads?.signal;
    let sealed: ArrayBuffer;
    try {
      sealed = await this.deps.fetchSegment(this.liveId, s.name, signal);
    } catch (e) {
      // A cancelled stale seek is not a failure: its target is gone, and the newer seek serves its own.
      if (ticket && this.isStale(ticket)) return null;
      if (!isLiveRefusal(e, 'not-found')) throw e;
      // A 404 is an ANSWER: the server is reachable, so an older retry's reconnecting screen ends here.
      this.answered();
      console.warn(`[LIVE_REPLAY] ${this.liveId}: segment ${s.index} is gone - skipped`);
      this.skipped++;
      this.skippedIdx.add(s.index);
      return null;
    }
    this.answered();
    if (!this.alive(gen) || this.keyHex === null) return null;
    if (ticket && this.isStale(ticket)) return null;
    return sealed;
  }

  /**
   * Fetches and opens one segment. A segment the server no longer has (`404`) is skipped; one that
   * does not open is skipped up to {@link MAX_CONSECUTIVE_FAILURES} in a row.
   */
  private async openOne(
    gen: number,
    s: LiveReplaySegment,
    ticket?: SeekTicket,
    preSealed?: ArrayBuffer
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    let sealed = preSealed ?? (await this.download(gen, s, ticket));
    const key = this.keyHex;
    if (sealed === null || key === null) return null;
    try {
      let media: Uint8Array<ArrayBuffer>;
      try {
        media = await this.deps.openSegment(key, this.liveId, s.index, sealed);
      } catch (e) {
        if (!(e instanceof LiveSegmentOpenError)) throw e;
        // A corrupted transfer opens on the second download: one more try before it is skipped.
        console.warn(
          `[LIVE_REPLAY] ${this.liveId}: segment ${s.index} did not open - downloading it again`
        );
        // The same handling as the first download: a stale seek and a 404 are not failures here either.
        const again = await this.download(gen, s, ticket);
        if (again === null) return null;
        sealed = again;
        media = await this.deps.openSegment(key, this.liveId, s.index, sealed);
      }
      this.openFailures = 0;
      // Decrypted for a target that has since moved: not worth an append.
      if (ticket && this.isStale(ticket)) return null;
      return media;
    } catch (e) {
      if (!(e instanceof LiveSegmentOpenError)) throw e;
      this.openFailures++;
      console.error(
        `[LIVE_REPLAY] ${this.liveId}: segment ${s.index} did not open (${this.openFailures} in a row)`
      );
      if (this.openFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new StopOn({ kind: 'unavailable', reason: 'undecryptable' });
      }
      this.skipped++;
      this.skippedIdx.add(s.index);
      return null;
    }
  }

  /**
   * Takes one segment: open it, append its init when it differs from the last one appended, then its
   * fragment, and MEASURE where the buffer put it. Returns the media time it begins at, or null when
   * it was skipped or opened no new range.
   */
  private async take(
    gen: number,
    s: LiveReplaySegment,
    ticket?: SeekTicket,
    preSealed?: ArrayBuffer
  ): Promise<number | null> {
    const media = await this.openOne(gen, s, ticket, preSealed);
    if (!this.alive(gen) || !media || !this.buffer) return null;
    let end: number;
    try {
      end = initSegmentEnd(media);
    } catch (e) {
      if (!(e instanceof Fmp4ParseError)) throw e;
      console.error(
        `[LIVE_REPLAY] ${this.liveId}: segment ${s.index} is not framable (${e.message})`
      );
      throw new StopOn({ kind: 'unavailable', reason: 'playback' });
    }
    if (end === 0 && !this.lastInit) {
      console.warn(`[LIVE_REPLAY] ${this.liveId}: segment ${s.index} carries no init to start on`);
      throw new StopOn({ kind: 'unavailable', reason: 'playback' });
    }
    const before = spansOf(this.buffer);
    await this.appendMedia(gen, media, end);
    if (!this.alive(gen) || !this.buffer) return null;
    let extent = newMediaExtent(before, spansOf(this.buffer));
    if (extent !== null && this.appended === 0 && extent[0] > REBASE_THRESHOLD_S) {
      extent = await this.rebaseToZero(gen, media, end, extent[0]);
    }
    const start = extent === null ? null : extent[0];
    this.appended++;
    this.retryAttempt = 0;
    // A step that answers again after a reconnect is the end of the reconnecting screen.
    if (this.state.kind === 'reconnecting') this.setState({ kind: 'playing' });
    if (extent !== null) this.measure(s.index, extent);
    return start;
  }

  /**
   * Records where segment `index` lies in media time. A MEASUREMENT NEVER NARROWS: a segment's place is
   * fixed, and the extent of a re-take is only what the buffer did not already hold (a segment the trim
   * cut in the middle re-adds just its cut part), so the start keeps the smaller and the end the larger
   * of the old and new values. A new extent reaching OUTSIDE the old one by more than a frame says the
   * segment moved, which nothing should cause: said at warn.
   */
  private measure(index: number, extent: MediaSpan): void {
    const from = this.placed.get(index);
    const to = this.placedEnd.get(index);
    if (from !== undefined && to !== undefined) {
      if (extent[0] < from - MEASURE_FRAME_S || extent[1] > to + MEASURE_FRAME_S) {
        console.warn(
          `[LIVE_REPLAY] ${this.liveId}: segment ${index} measured ${extent[0].toFixed(2)}-${extent[1].toFixed(2)} s, was ${from.toFixed(2)}-${to.toFixed(2)} s`
        );
      }
      this.placed.set(index, Math.min(from, extent[0]));
      this.placedEnd.set(index, Math.max(to, extent[1]));
      return;
    }
    this.placed.set(index, extent[0]);
    this.placedEnd.set(index, extent[1]);
  }

  /** Appends the init (when it differs) and the fragment of one opened segment. */
  private async appendMedia(
    gen: number,
    media: Uint8Array<ArrayBuffer>,
    end: number
  ): Promise<void> {
    if (end > 0) {
      const init = media.subarray(0, end);
      if (!this.lastInit || !sameBytes(init, this.lastInit)) {
        if (this.lastInit) console.debug(`[LIVE_REPLAY] ${this.liveId}: a new init`);
        await this.append(gen, init);
        this.lastInit = init.slice();
      }
    }
    let body = media.subarray(end);
    if (body.byteLength === 0 || !this.lastInit) return;
    try {
      // The last video frame given the interval the camera ran at (the audio-ahead drift).
      body = this.holds.apply(`[LIVE_REPLAY] ${this.liveId}`, this.lastInit, body);
    } catch (e) {
      if (!(e instanceof Fmp4ParseError)) throw e;
      console.error(`[LIVE_REPLAY] ${this.liveId}: a fragment is not framable (${e.message})`);
      throw new StopOn({ kind: 'unavailable', reason: 'playback' });
    }
    await this.append(gen, body);
  }

  /**
   * THE FIRST APPEND LANDED PAST ZERO (a replay trimmed to its last three hours): everything is
   * removed and the segment appended again under a `timestampOffset` that brings it to zero, so the
   * player's bar reads the replay's own length. Returns where the segment begins afterwards.
   */
  private async rebaseToZero(
    gen: number,
    media: Uint8Array<ArrayBuffer>,
    end: number,
    placedAt: number
  ): Promise<MediaSpan | null> {
    const buffer = this.buffer;
    if (!buffer) return null;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: first media at ${placedAt.toFixed(2)} s - rebased to zero`
    );
    await settleBuffer(buffer, () => buffer.remove(0, Number.MAX_SAFE_INTEGER));
    buffer.timestampOffset = -placedAt;
    // The init is appended again with it: the engine's last init is the one under the new offset.
    this.lastInit = null;
    // The first append is undone, and its count with it: the segment is held and counted again.
    this.holds.reset();
    const before = spansOf(buffer);
    await this.appendMedia(gen, media, end);
    return newMediaExtent(before, spansOf(buffer));
  }

  /**
   * Appends bytes and waits for the buffer to settle. A failure counts towards "unplayable"; only a
   * successful APPEND resets that count.
   */
  private async append(gen: number, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || !this.alive(gen)) return;
    try {
      await settleBuffer(buffer, () => buffer.appendBuffer(bytes));
      this.appendFailures = 0;
    } catch (e) {
      if (!this.alive(gen)) return;
      this.appendFailures++;
      console.error(
        `[LIVE_REPLAY] ${this.liveId}: append failed (${this.appendFailures} in a row)`,
        e
      );
      if (this.lastInit === null || this.appendFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new StopOn({ kind: 'unavailable', reason: 'playback' });
      }
    }
  }

  /**
   * Drops what lies more than {@link REPLAY_BEHIND_S} behind the playhead and what lies more than
   * {@link REPLAY_FAR_AHEAD_S} ahead of it (a region an older seek left). Where the segments sat in
   * media time is a MEASURED fact and stays: only what the buffer holds is forgotten.
   */
  private async trim(gen: number): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || buffer.buffered.length === 0) return;
    const at = this.video.currentTime;
    const cut = at - REPLAY_BEHIND_S;
    // Far ahead is measured in MEDIA seconds across the known holes, never less than the same distance
    // in media time: a 80 s pause must not make the media right after it "far".
    const far = Math.max(at + REPLAY_FAR_AHEAD_S, this.positionAhead(at, REPLAY_FAR_AHEAD_S));
    const first = buffer.buffered.start(0);
    const last = buffer.buffered.end(buffer.buffered.length - 1);
    try {
      if (cut - first >= REPLAY_BEHIND_S) {
        await settleBuffer(buffer, () => buffer.remove(0, cut));
      }
      if (this.alive(gen) && last > far) {
        await settleBuffer(buffer, () => buffer.remove(far, Number.MAX_SAFE_INTEGER));
      }
    } catch (e) {
      // Nothing lost but memory; said and left to the next trim.
      console.warn(`[LIVE_REPLAY] ${this.liveId}: trim failed (${String(e)})`);
    }
  }

  private resume(): void {
    if (!this.video.paused) return;
    this.video.play().catch((e: unknown) => {
      // An autoplay refusal (sound without a gesture): the player's own controls start it.
      console.warn(`[LIVE_REPLAY] ${this.liveId}: play() refused (${String(e)})`);
    });
  }

  private summarise(why: string): void {
    if (this.appended === 0 && this.skipped === 0) return;
    console.log(
      `[LIVE_REPLAY] ${this.liveId} (${why}): ${this.appended} segments played, ${this.skipped} skipped, ${this.seeks} seeks, ${this.holds.count} last frames held`
    );
  }
}

/** A short, key-free description of a failure for a log line. */
function describe(error: unknown): string {
  if (error instanceof StopOn) return error.state.kind;
  if (error instanceof LiveRefusalError) return `${error.status} ${error.kind}`;
  return error instanceof Error ? error.name : String(error);
}
