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
import { Fmp4ParseError, initSegmentEnd } from './fmp4Segments';
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
import { segmentPositionAt } from './replayTimeline';
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
  const held = [...before].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of after) {
    // Sweep the old ranges across this one: `from` is the first instant none of them holds.
    let from = start;
    for (const [b0, b1] of held) {
      if (b1 <= from) continue;
      if (b0 > from + 0.05) break;
      from = Math.max(from, b1);
    }
    if (end - from > 0.05) return from;
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
/** How many segments in a row may fail to open or append before the replay is called unplayable. */
const MAX_CONSECUTIVE_FAILURES = 3;
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
  private lastInit: Uint8Array | null = null;
  private retryAttempt = 0;
  private openFailures = 0;
  private appendFailures = 0;
  private skipped = 0;
  private appended = 0;
  private seeks = 0;
  private state: ReplayState = { kind: 'connecting' };

  /** The serial queue: one buffer operation at a time, in order. */
  private tail: Promise<void> = Promise.resolve();
  /** A fill is queued: `timeupdate` asks for more media at most once at a time. */
  private fillQueued = false;
  /** A seek is waiting its turn: the running fill yields so the seek is not made to wait for 12 s of media. */
  private seekPending = false;
  /** The end of the stream was declared (the last segment is in): said once per arrival at the end. */
  private ended = false;

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
    if (!this.running || this.fillQueued || !this.buffer) return;
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
    this.enqueue(gen, async () => {
      this.seekPending = false;
      const span = spansOf(this.buffer as ReplaySourceBufferLike).find(
        ([s, e]) => at >= s - 0.01 && at < e
      );
      if (span) {
        this.cursor = this.cursorAfter(span);
        console.debug(
          `[LIVE_REPLAY] seek to ${at.toFixed(2)}: buffered, next segment ${this.cursor}`
        );
      } else {
        await this.seekTo(gen, at * 1000);
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
    if (spans.some(([s, e]) => at >= s - 0.01 && at < e - 0.05)) return;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: waiting on a hole at ${at.toFixed(2)} - re-anchoring`
    );
    this.noteSeeking();
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
    this.lastInit = null;
    this.retryAttempt = 0;
    this.openFailures = 0;
    this.appendFailures = 0;
    this.skipped = 0;
    this.appended = 0;
    this.seeks = 0;
    this.tail = Promise.resolve();
    this.fillQueued = false;
    this.seekPending = false;
    this.ended = false;
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
    this.segments.push(
      ...page.segments.filter((s) => s.index >= (this.segments.at(-1)?.index ?? -1) + 1)
    );
    this.nextFrom = page.nextFrom;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: ${this.segments.length} segments listed${page.nextFrom === null ? ' (all)' : ''}`
    );
  }

  /** Lists pages until a segment at or past `ms` is known, or the list is whole. */
  private async listUntil(gen: number, ms: number): Promise<void> {
    while (this.alive(gen) && this.nextFrom !== null && (this.segments.at(-1)?.atMs ?? -1) < ms) {
      await this.loadPage(gen);
    }
  }

  /**
   * Keeps {@link REPLAY_AHEAD_S} of media ahead of the playhead, taking segments from the cursor; at
   * the end of the list it declares the end of the stream. Yields to a waiting seek.
   */
  private async fill(gen: number): Promise<void> {
    while (this.alive(gen) && !this.seekPending) {
      if (this.cursor >= this.segments.length) {
        if (this.nextFrom !== null) {
          await this.loadPage(gen);
          continue;
        }
        this.declareEnd(gen);
        return;
      }
      if (this.mediaAhead() >= REPLAY_AHEAD_S) return;
      const s = this.segments[this.cursor];
      this.cursor++;
      if (this.isBuffered(s.index)) continue;
      await this.take(gen, s);
    }
  }

  /** The last segment is in: the stream ends, and the engine's `ended` closes the picture. Once. */
  private declareEnd(gen: number): void {
    const source = this.source;
    if (this.ended || !source || !this.alive(gen) || source.readyState !== 'open') return;
    if (this.buffer?.updating) return;
    this.ended = true;
    try {
      source.endOfStream();
      console.debug(
        `[LIVE_REPLAY] ${this.liveId}: end of stream declared at ${this.cursor} segments`
      );
    } catch (e) {
      console.warn(`[LIVE_REPLAY] ${this.liveId}: endOfStream refused (${String(e)})`);
    }
  }

  /** Media buffered ahead of the playhead, in seconds; 0 when the playhead is not on a range. */
  private mediaAhead(): number {
    const at = this.video.currentTime;
    const span = this.buffer
      ? spansOf(this.buffer).find(([s, e]) => at >= s - 0.01 && at < e)
      : undefined;
    return span ? span[1] - at : 0;
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
    return Math.max(0, segmentPositionAt(this.segments, span[1] * 1000)) + 1;
  }

  /** A seek to `ms` of the replay: the target's segment is taken and the playhead put where it landed. */
  private async seekTo(gen: number, ms: number): Promise<void> {
    await this.listUntil(gen, ms);
    if (!this.alive(gen)) return;
    const pos = segmentPositionAt(this.segments, ms);
    if (pos < 0) return;
    const s = this.segments[pos];
    this.seeks++;
    const start = await this.take(gen, s);
    if (!this.alive(gen)) return;
    this.cursor = pos + 1;
    if (start !== null) {
      // Inside the segment by the share of it the target is past, never beyond its own length.
      this.video.currentTime = start + Math.min(Math.max(0, (ms - s.atMs) / 1000), 1.5);
    }
    this.ended = false;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: seek to ${Math.round(ms)} ms -> segment ${s.index}`
    );
    this.resume();
  }

  /**
   * Fetches and opens one segment. A segment the server no longer has (`404`) is skipped; one that
   * does not open is skipped up to {@link MAX_CONSECUTIVE_FAILURES} in a row.
   */
  private async openOne(
    gen: number,
    s: LiveReplaySegment
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    let sealed: ArrayBuffer;
    try {
      sealed = await this.deps.fetchSegment(this.liveId, s.name, this.downloads?.signal);
    } catch (e) {
      if (!isLiveRefusal(e, 'not-found')) throw e;
      console.warn(`[LIVE_REPLAY] ${this.liveId}: segment ${s.index} is gone - skipped`);
      this.skipped++;
      return null;
    }
    if (!this.alive(gen) || this.keyHex === null) return null;
    try {
      const media = await this.deps.openSegment(this.keyHex, this.liveId, s.index, sealed);
      this.openFailures = 0;
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
      return null;
    }
  }

  /**
   * Takes one segment: open it, append its init when it differs from the last one appended, then its
   * fragment, and MEASURE where the buffer put it. Returns the media time it begins at, or null when
   * it was skipped or opened no new range.
   */
  private async take(gen: number, s: LiveReplaySegment): Promise<number | null> {
    const media = await this.openOne(gen, s);
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
    let start = newMediaStart(before, spansOf(this.buffer));
    if (start !== null && this.appended === 0 && start > REBASE_THRESHOLD_S) {
      start = await this.rebaseToZero(gen, media, end, start);
    }
    this.appended++;
    this.retryAttempt = 0;
    // A step that answers again after a reconnect is the end of the reconnecting screen.
    if (this.state.kind === 'reconnecting') this.setState({ kind: 'playing' });
    if (start !== null) this.placed.set(s.index, start);
    return start;
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
    const body = media.subarray(end);
    if (body.byteLength > 0) await this.append(gen, body);
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
  ): Promise<number | null> {
    const buffer = this.buffer;
    if (!buffer) return null;
    console.debug(
      `[LIVE_REPLAY] ${this.liveId}: first media at ${placedAt.toFixed(2)} s - rebased to zero`
    );
    await settleBuffer(buffer, () => buffer.remove(0, Number.MAX_SAFE_INTEGER));
    buffer.timestampOffset = -placedAt;
    // The init is appended again with it: the engine's last init is the one under the new offset.
    this.lastInit = null;
    const before = spansOf(buffer);
    await this.appendMedia(gen, media, end);
    return newMediaStart(before, spansOf(buffer));
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
   * {@link REPLAY_FAR_AHEAD_S} ahead of it (a region an older seek left), and forgets where those
   * segments were placed.
   */
  private async trim(gen: number): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || buffer.buffered.length === 0) return;
    const at = this.video.currentTime;
    const cut = at - REPLAY_BEHIND_S;
    const far = at + REPLAY_FAR_AHEAD_S;
    const first = buffer.buffered.start(0);
    const last = buffer.buffered.end(buffer.buffered.length - 1);
    try {
      if (cut - first >= REPLAY_BEHIND_S) {
        await settleBuffer(buffer, () => buffer.remove(0, cut));
        for (const [i, p] of this.placed) if (p < cut) this.placed.delete(i);
      }
      if (this.alive(gen) && last > far) {
        await settleBuffer(buffer, () => buffer.remove(far, Number.MAX_SAFE_INTEGER));
        for (const [i, p] of this.placed) if (p >= far) this.placed.delete(i);
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
      `[LIVE_REPLAY] ${this.liveId} (${why}): ${this.appended} segments played, ${this.skipped} skipped, ${this.seeks} seeks`
    );
  }
}

/** A short, key-free description of a failure for a log line. */
function describe(error: unknown): string {
  if (error instanceof StopOn) return error.state.kind;
  if (error instanceof LiveRefusalError) return `${error.status} ${error.kind}`;
  return error instanceof Error ? error.name : String(error);
}
