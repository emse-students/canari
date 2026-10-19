/**
 * THE LIVE VIEWER'S PLAYER: a growing fMP4 source fed through Media Source Extensions, one sealed
 * segment at a time, kept about one segment behind the live edge (WP-L5).
 *
 * The sequence is the one the WP-L1 bench measured (0 append errors in ~2 200 segments, Chromium
 * `MediaSource` and iOS WebKit `ManagedMediaSource`; `tools/live-bench/bench.js` on
 * `bench/live-wp-l1`):
 *
 * 1. `GET /api/lives/:id` - the key, and a seat on the host's viewer cap.
 * 2. One `SourceBuffer` of {@link LIVE_RECORDER_MIME}, `mode = 'segments'`.
 * 3. The JOIN: the newest manifest window; the INIT (`ftyp` + `moov`, at the head of segment 0 only)
 *    appended once, then the newest segment's media, then a seek to the live edge.
 * 4. A manifest poll every {@link LIVE_MANIFEST_POLL_MS} from the last index taken; each new
 *    segment fetched (the plain public fetch), opened with the live key, appended in order. More than
 *    {@link LIVE_PLAYER_CATCHUP_SEGMENTS} new at once, or a gap the window already passed, or a stall,
 *    and the player jumps to the newest and seeks to the edge rather than replaying the backlog.
 *
 * Every failure goes through {@link liveFailureOutcome}, ONE decision: a state to stop on, or a
 * retry with a backoff while the screen says "reconnecting". The end is the server's verdict (`410`,
 * or the `404` of a live deleted at its end), never a client timer.
 *
 * EVERYTHING OUTSIDE THIS FILE IS INJECTED ({@link LivePlayerDeps}): the API, the seal, the media
 * source, the timer. So the state machine is tested with fake MSE objects and a manual clock, no
 * sleep and no wall clock. Nothing here logs the key or a segment's bytes; segments are summarised,
 * never logged one by one at info level.
 */

import {
  fetchLive,
  fetchLiveManifest,
  fetchLiveSegment,
  leaveLiveSeat,
  isLiveRefusal,
} from './api';
import { LiveSegmentOpenError, openLiveSegment } from './liveCrypto';
import { initSegmentEnd } from './fmp4';
import {
  LIVE_BROADCASTER_QUIET_MS,
  LIVE_MANIFEST_POLL_MS,
  LIVE_PLAYER_CATCHUP_SEGMENTS,
  LIVE_PLAYER_KEEP_BEHIND_MS,
  LIVE_PLAYER_MAX_BEHIND_MS,
  LIVE_PLAYER_TARGET_BUFFER_MS,
  LIVE_RECORDER_MIME,
} from './constants';
import {
  isTerminalLiveState,
  liveFailureOutcome,
  liveRetryDelayMs,
  type LiveViewerState,
} from './liveViewerState';
import type { LiveManifest, LiveManifestSegment } from './types';

/** The `buffered` ranges of a source buffer, as MSE gives them. */
export interface LiveTimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/** The part of a `SourceBuffer` the player uses. */
export interface LiveSourceBufferLike extends EventTarget {
  readonly updating: boolean;
  mode: string;
  readonly buffered: LiveTimeRanges;
  appendBuffer(data: Uint8Array<ArrayBuffer>): void;
  remove(start: number, end: number): void;
}

/** The part of a `MediaSource` / `ManagedMediaSource` the player uses. */
export interface LiveMediaSourceLike extends EventTarget {
  readonly readyState: string;
  addSourceBuffer(type: string): LiveSourceBufferLike;
}

/** Which MSE flavour this engine offers, and whether it plays the live's container. */
export interface LiveMediaSourceKind {
  name: 'MediaSource' | 'ManagedMediaSource';
  create(): LiveMediaSourceLike;
  isTypeSupported(type: string): boolean;
}

/** The part of the `<video>` the player drives. */
export interface LiveVideoLike {
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
}

/** What the player needs from outside: the network, the seal, the media source, a timer. */
export interface LivePlayerDeps {
  fetchLive: typeof fetchLive;
  fetchManifest: typeof fetchLiveManifest;
  fetchSegment: typeof fetchLiveSegment;
  openSegment: typeof openLiveSegment;
  leaveSeat: typeof leaveLiveSeat;
  /** The engine's MSE flavour, or null when it has none. */
  mediaSource(): LiveMediaSourceKind | null;
  /** Points the video at the source; returns what undoes it (revoke the object URL). */
  attach(source: LiveMediaSourceLike): () => void;
  /** Runs `fn` after `ms`; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

/** Options of a {@link LivePlayer}. */
export interface LivePlayerOptions {
  liveId: string;
  video: LiveVideoLike;
  /** Told every state change. */
  onState(state: LiveViewerState): void;
  /** Told the live's age at each manifest (the database's clock on both ends), in ms. */
  onElapsed?(ms: number): void;
  deps?: Partial<LivePlayerDeps>;
}

/** The `SourceBuffer` type of {@link LIVE_RECORDER_MIME}: the codecs list quoted, as MSE expects it. */
export function liveSourceBufferType(mime: string = LIVE_RECORDER_MIME): string {
  const m = /^([^;]+);\s*codecs=([^;"]+)$/.exec(mime);
  return m ? `${m[1]}; codecs="${m[2]}"` : mime;
}

/**
 * The engine's MSE flavour: `MediaSource` where it exists (Chromium, desktop Safari),
 * `ManagedMediaSource` otherwise (iPhone WebKit, which has no `MediaSource`). The bench's order.
 */
export function browserMediaSource(): LiveMediaSourceKind | null {
  const g = globalThis as unknown as {
    MediaSource?: { new (): MediaSource; isTypeSupported(t: string): boolean };
    ManagedMediaSource?: { new (): MediaSource; isTypeSupported(t: string): boolean };
  };
  if (g.MediaSource) {
    const C = g.MediaSource;
    return {
      name: 'MediaSource',
      create: () => new C() as unknown as LiveMediaSourceLike,
      isTypeSupported: (t) => C.isTypeSupported(t),
    };
  }
  if (g.ManagedMediaSource) {
    const C = g.ManagedMediaSource;
    return {
      name: 'ManagedMediaSource',
      create: () => new C() as unknown as LiveMediaSourceLike,
      isTypeSupported: (t) => C.isTypeSupported(t),
    };
  }
  return null;
}

const defaultDeps: Omit<LivePlayerDeps, 'attach'> = {
  fetchLive,
  fetchManifest: fetchLiveManifest,
  fetchSegment: fetchLiveSegment,
  openSegment: openLiveSegment,
  leaveSeat: leaveLiveSeat,
  mediaSource: browserMediaSource,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** How many segments in a row may fail to open or append before the live is called unplayable. */
const MAX_CONSECUTIVE_SEGMENT_FAILURES = 3;

/** One summary line per this many segments appended - never a line per segment at info level. */
const SUMMARY_EVERY = 30;

/** Thrown inside the player to stop on a state; never leaves it. */
class StopOn extends Error {
  constructor(readonly state: LiveViewerState) {
    super(`stop on ${state.kind}`);
  }
}

/**
 * ONE PLAYER PER OPEN VIEWER. `start()` opens it, `stop()` gives everything back (timers, the
 * source, the seat). `retry()` starts again from the key, for the "live complet" screen's button.
 */
export class LivePlayer {
  private readonly deps: LivePlayerDeps;
  private readonly liveId: string;
  private readonly video: LiveVideoLike;
  private readonly opts: LivePlayerOptions;

  /** Bumped by every start and stop: a continuation of an older run sees it changed and returns. */
  private generation = 0;
  private cancelTimer: (() => void) | null = null;
  private detach: (() => void) | null = null;

  private keyHex: string | null = null;
  private startedAtMs = 0;
  private seated = false;
  private source: LiveMediaSourceLike | null = null;
  private buffer: LiveSourceBufferLike | null = null;
  private initAppended = false;
  private joined = false;
  /** The highest index taken (appended or skipped); -1 before the join. */
  private last = -1;
  private retryAttempt = 0;
  private segmentFailures = 0;
  private stalled = false;
  private broadcasterQuiet = false;
  private state: LiveViewerState = { kind: 'connecting' };

  private appended = 0;
  private skipped = 0;
  private seeks = 0;

  constructor(opts: LivePlayerOptions) {
    this.opts = opts;
    this.liveId = opts.liveId;
    this.video = opts.video;
    const attach =
      opts.deps?.attach ??
      (() => {
        throw new Error('LivePlayer: no attach given');
      });
    this.deps = { ...defaultDeps, ...opts.deps, attach };
  }

  /** The state on screen now. */
  get current(): LiveViewerState {
    return this.state;
  }

  /** Opens the live: key and seat, the source, the join, then the poll. */
  start(): void {
    console.debug(`[LIVE] viewer start ${this.liveId}`);
    this.teardownMedia();
    const gen = ++this.generation;
    this.resetRun();
    // Said even when it already was: the screen leaves a final state for this one.
    this.state = { kind: 'connecting' };
    this.opts.onState(this.state);
    void this.open(gen);
  }

  /** The reader asked again (the "live complet" or "indisponible" screen's button). */
  retry(): void {
    console.debug(`[LIVE] viewer retry ${this.liveId} from ${this.state.kind}`);
    this.start();
  }

  /**
   * Closes the viewer: every timer and the source go, and the seat goes back to the host's cap now
   * (best effort - its 30 s lease is the bound if this request is lost).
   */
  stop(): void {
    console.debug(`[LIVE] viewer stop ${this.liveId} (${this.state.kind})`);
    this.generation++;
    this.summarise('stopped');
    this.teardownMedia();
    this.giveBackSeat();
  }

  /** The video ran dry (`waiting`): the next segment that lands seeks back to the live edge. */
  noteStall(): void {
    if (!this.joined || this.stalled) return;
    console.debug(`[LIVE] viewer ${this.liveId} stalled at ${this.video.currentTime.toFixed(2)}`);
    this.stalled = true;
  }

  // ------------------------------------------------------------------------------------------

  private resetRun(): void {
    this.keyHex = null;
    this.initAppended = false;
    this.joined = false;
    this.last = -1;
    this.retryAttempt = 0;
    this.segmentFailures = 0;
    this.stalled = false;
    this.broadcasterQuiet = false;
    this.appended = 0;
    this.skipped = 0;
    this.seeks = 0;
  }

  private alive(gen: number): boolean {
    return gen === this.generation;
  }

  private setState(next: LiveViewerState): void {
    const same =
      next.kind === this.state.kind && JSON.stringify(next) === JSON.stringify(this.state);
    this.state = next;
    if (same) return;
    console.debug(
      `[LIVE] viewer ${this.liveId} -> ${next.kind}${'reason' in next ? ` (${next.reason})` : ''}`
    );
    this.opts.onState(next);
  }

  private later(gen: number, ms: number, step: (gen: number) => Promise<void>): void {
    this.cancelTimer?.();
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = null;
      if (this.alive(gen)) void step(gen);
    }, ms);
  }

  private teardownMedia(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.detach?.();
    this.detach = null;
    this.source = null;
    this.buffer = null;
  }

  private giveBackSeat(): void {
    if (!this.seated) return;
    this.seated = false;
    this.deps.leaveSeat(this.liveId).catch((e: unknown) => {
      // Best effort: the 30 s lease frees the seat anyway. Said, never swallowed.
      console.warn(`[LIVE] viewer ${this.liveId}: the seat could not be given back (${String(e)})`);
    });
  }

  /** Every failure of a step, decided once: stop on a state, or retry `step` after a backoff. */
  private fail(gen: number, error: unknown, step: (gen: number) => Promise<void>): void {
    if (!this.alive(gen)) return;
    const outcome =
      error instanceof StopOn ? { stop: error.state } : liveFailureOutcome(error, this.joined);
    if (outcome === 'retry') {
      this.retryAttempt++;
      const wait = liveRetryDelayMs(this.retryAttempt);
      console.warn(
        `[LIVE] viewer ${this.liveId}: no answer or busy (${describe(error)}), retry ${this.retryAttempt} in ${wait} ms`
      );
      this.setState({ kind: 'reconnecting', reason: 'network' });
      this.later(gen, wait, step);
      return;
    }
    const final = outcome.stop;
    if (
      final.kind === 'unavailable' &&
      !(error instanceof StopOn) &&
      !isLiveRefusal(error, 'not-found')
    ) {
      console.error(`[LIVE] viewer ${this.liveId}: stopped (${describe(error)})`, error);
    } else {
      console.warn(`[LIVE] viewer ${this.liveId}: stopped on ${final.kind} (${describe(error)})`);
    }
    this.generation++;
    this.summarise(final.kind);
    this.cancelTimer?.();
    this.cancelTimer = null;
    // A refused seat (`full`) was never held, and an ended live freed every seat on the server.
    if (final.kind === 'full' || final.kind === 'ended') this.seated = false;
    else this.giveBackSeat();
    if (final.kind === 'ended') this.video.pause();
    this.setState(final);
  }

  /**
   * Steps 1 to 3: the key and the seat, the source, the join. Re-entrant - a retry runs it again and
   * it skips what is already done (the key held, the source open, the init appended).
   */
  private async open(gen: number): Promise<void> {
    try {
      // The source first: an engine that cannot play the live never takes a seat from the cap.
      if (!this.buffer) await this.openSource(gen);
      if (!this.alive(gen)) return;
      if (this.keyHex === null) {
        const live = await this.deps.fetchLive(this.liveId);
        this.seated = true;
        if (!this.alive(gen)) {
          // Closed while the key was on its way: the seat it took goes straight back.
          this.giveBackSeat();
          return;
        }
        this.keyHex = live.key;
        this.startedAtMs = Date.parse(live.startedAt);
        this.retryAttempt = 0;
      }
      await this.join(gen);
    } catch (e) {
      this.fail(gen, e, (g) => this.open(g));
    }
  }

  /** Step 2: the media source and its one buffer. */
  private async openSource(gen: number): Promise<void> {
    const kind = this.deps.mediaSource();
    const type = liveSourceBufferType();
    if (!kind || !kind.isTypeSupported(type)) {
      console.warn(
        `[LIVE] viewer: ${kind ? `${kind.name} cannot play ${type}` : 'no MediaSource on this engine'}`
      );
      throw new StopOn({ kind: 'unavailable', reason: 'unsupported' });
    }
    const source = kind.create();
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
    console.debug(`[LIVE] viewer source open (${kind.name}, ${type})`);
  }

  /** Step 3: the newest window, the init once, the newest segment, the edge. */
  private async join(gen: number): Promise<void> {
    const manifest = await this.deps.fetchManifest(this.liveId);
    if (!this.alive(gen)) return;
    this.retryAttempt = 0;
    this.readClock(manifest);
    const newest = manifest.segments.at(-1);
    if (!newest) {
      // On air, no segment stored yet: ask again at the poll's pace.
      console.debug(`[LIVE] viewer ${this.liveId}: no segment yet, waiting`);
      this.later(gen, LIVE_MANIFEST_POLL_MS, (g) => this.open(g));
      return;
    }
    if (!this.initAppended) {
      const zero =
        newest.index === 0
          ? newest
          : (await this.deps.fetchManifest(this.liveId, 0)).segments.find((s) => s.index === 0);
      if (!this.alive(gen)) return;
      if (!zero) {
        console.warn(`[LIVE] viewer ${this.liveId}: segment 0 (the init) is not in the manifest`);
        throw new StopOn({ kind: 'unavailable', reason: 'playback' });
      }
      const first = await this.openOne(gen, zero, true);
      if (!first || !this.alive(gen)) return;
      const end = initSegmentEnd(first);
      if (end === 0) {
        console.warn(`[LIVE] viewer ${this.liveId}: segment 0 carries no init`);
        throw new StopOn({ kind: 'unavailable', reason: 'playback' });
      }
      await this.append(first.subarray(0, end));
      this.initAppended = true;
      if (newest.index === 0) {
        if (end < first.byteLength) await this.append(first.subarray(end));
        this.last = 0;
      }
    }
    if (!this.alive(gen)) return;
    if (newest.index > this.last) await this.take(gen, newest);
    if (!this.alive(gen)) return;
    this.joined = true;
    this.seekToEdge('join');
    console.log(`[LIVE] viewer joined ${this.liveId} at segment ${newest.index}`);
    this.showPlaying();
    this.later(gen, LIVE_MANIFEST_POLL_MS, (g) => this.poll(g));
  }

  /** Step 4: one manifest poll and what it brought. */
  private async poll(gen: number): Promise<void> {
    try {
      const manifest = await this.deps.fetchManifest(this.liveId, this.last + 1);
      if (!this.alive(gen)) return;
      this.retryAttempt = 0;
      this.readClock(manifest);
      let fresh = manifest.segments.filter((s) => s.index > this.last);
      let edge = this.stalled;
      if (fresh.length > 0) {
        const gap = fresh[0].index > this.last + 1;
        if (gap || fresh.length > LIVE_PLAYER_CATCHUP_SEGMENTS) {
          const newest = fresh[fresh.length - 1];
          console.debug(
            `[LIVE] viewer ${this.liveId}: ${gap ? 'a gap' : `${fresh.length} segments behind`} - jumping from ${this.last} to ${newest.index}`
          );
          this.skipped += newest.index - this.last - 1;
          fresh = [newest];
          edge = true;
        }
        for (const s of fresh) {
          await this.take(gen, s);
          if (!this.alive(gen)) return;
        }
        if (edge || this.behindMs() > LIVE_PLAYER_MAX_BEHIND_MS) {
          this.seekToEdge(edge ? (this.stalled ? 'stall' : 'catch-up') : 'drift');
        }
        this.stalled = false;
        await this.trim();
        if (!this.alive(gen)) return;
      }
      this.showPlaying();
      this.later(gen, LIVE_MANIFEST_POLL_MS, (g) => this.poll(g));
    } catch (e) {
      this.fail(gen, e, (g) => this.poll(g));
    }
  }

  /**
   * Fetches and opens one segment. A segment the server no longer has (`404`) is skipped - the next
   * manifest says whether the live ended. One that does not open is skipped too, up to
   * {@link MAX_CONSECUTIVE_SEGMENT_FAILURES} in a row; the init (`required`) cannot be skipped.
   * Returns null when skipped.
   */
  private async openOne(
    gen: number,
    s: LiveManifestSegment,
    required = false
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    let sealed: ArrayBuffer;
    try {
      sealed = await this.deps.fetchSegment(this.liveId, s.name);
    } catch (e) {
      if (!isLiveRefusal(e, 'not-found') || required) throw e;
      console.warn(`[LIVE] viewer ${this.liveId}: segment ${s.index} is gone - skipped`);
      this.skipped++;
      return null;
    }
    if (!this.alive(gen) || this.keyHex === null) return null;
    try {
      const media = await this.deps.openSegment(this.keyHex, this.liveId, s.index, sealed);
      this.segmentFailures = 0;
      return media;
    } catch (e) {
      if (!(e instanceof LiveSegmentOpenError)) throw e;
      this.segmentFailures++;
      console.error(
        `[LIVE] viewer ${this.liveId}: segment ${s.index} did not open (${this.segmentFailures} in a row)`
      );
      if (required || this.segmentFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
        throw new StopOn({ kind: 'unavailable', reason: 'undecryptable' });
      }
      this.skipped++;
      return null;
    }
  }

  /** Takes one media segment: open it, drop a leading init if it carries one, append the rest. */
  private async take(gen: number, s: LiveManifestSegment): Promise<void> {
    const media = await this.openOne(gen, s);
    if (!this.alive(gen)) return;
    this.last = Math.max(this.last, s.index);
    if (!media) return;
    const end = initSegmentEnd(media);
    const body = end > 0 ? media.subarray(end) : media;
    if (body.byteLength > 0) await this.append(body);
    this.appended++;
    if (this.appended % SUMMARY_EVERY === 0) this.summarise('playing');
  }

  /** Appends bytes and waits for the buffer to settle. A failure counts towards "unplayable". */
  private async append(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) return;
    try {
      await settleBuffer(buffer, () => buffer.appendBuffer(bytes));
      this.segmentFailures = 0;
    } catch (e) {
      this.segmentFailures++;
      console.error(
        `[LIVE] viewer ${this.liveId}: append failed (${this.segmentFailures} in a row)`,
        e
      );
      if (!this.initAppended || this.segmentFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
        throw new StopOn({ kind: 'unavailable', reason: 'playback' });
      }
    }
  }

  /** Drops what was played long ago, so the buffer stays small for a live of an hour. */
  private async trim(): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || buffer.buffered.length === 0) return;
    const keep = LIVE_PLAYER_KEEP_BEHIND_MS / 1000;
    const cut = this.video.currentTime - keep;
    if (cut - buffer.buffered.start(0) < keep) return;
    try {
      await settleBuffer(buffer, () => buffer.remove(0, cut));
    } catch (e) {
      // Nothing lost but memory; said and left to the next trim.
      console.warn(`[LIVE] viewer ${this.liveId}: trim failed (${String(e)})`);
    }
  }

  /** How far behind its buffered end the video plays, in ms. */
  private behindMs(): number {
    const ranges = this.buffer?.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return (ranges.end(ranges.length - 1) - this.video.currentTime) * 1000;
  }

  /** Puts the video one target buffer behind the newest buffered media, and plays. */
  private seekToEdge(why: string): void {
    const ranges = this.buffer?.buffered;
    if (!ranges || ranges.length === 0) return;
    const end = ranges.end(ranges.length - 1);
    const start = ranges.start(ranges.length - 1);
    this.video.currentTime = Math.max(start, end - LIVE_PLAYER_TARGET_BUFFER_MS / 1000);
    this.seeks++;
    console.debug(
      `[LIVE] viewer ${this.liveId}: seek to the live edge (${why}) at ${end.toFixed(2)}`
    );
    this.resume();
  }

  private resume(): void {
    if (!this.video.paused) return;
    this.video.play().catch((e: unknown) => {
      // An autoplay refusal (sound without a gesture): the screen's own controls start it.
      console.warn(`[LIVE] viewer ${this.liveId}: play() refused (${String(e)})`);
    });
  }

  /** The manifest's two database times: the live's age, and whether the broadcaster went quiet. */
  private readClock(manifest: LiveManifest): void {
    const now = Date.parse(manifest.serverNow);
    if (Number.isFinite(now) && Number.isFinite(this.startedAtMs)) {
      this.opts.onElapsed?.(Math.max(0, now - this.startedAtMs));
    }
    const lastAt = manifest.lastSegmentAt === null ? NaN : Date.parse(manifest.lastSegmentAt);
    const quiet =
      Number.isFinite(lastAt) && Number.isFinite(now) && now - lastAt > LIVE_BROADCASTER_QUIET_MS;
    if (quiet !== this.broadcasterQuiet) {
      console.debug(`[LIVE] viewer ${this.liveId}: broadcaster ${quiet ? 'quiet' : 'back'}`);
      this.broadcasterQuiet = quiet;
    }
  }

  private showPlaying(): void {
    if (isTerminalLiveState(this.state)) return;
    this.setState(
      this.broadcasterQuiet ? { kind: 'reconnecting', reason: 'broadcaster' } : { kind: 'playing' }
    );
  }

  private summarise(why: string): void {
    if (this.appended === 0 && this.skipped === 0) return;
    console.log(
      `[LIVE] viewer ${this.liveId} (${why}): ${this.appended} segments played, ${this.skipped} skipped, ${this.seeks} seeks, at ${this.last}`
    );
  }
}

/** A short, key-free description of a failure for a log line. */
function describe(error: unknown): string {
  if (error instanceof StopOn) return error.state.kind;
  if (error && typeof error === 'object' && 'kind' in error && 'status' in error) {
    const e = error as { kind: string; status: number };
    return `${e.status} ${e.kind}`;
  }
  return error instanceof Error ? error.name : String(error);
}

/**
 * Runs one buffer operation and resolves on its `updateend`, rejects on its `error` or its throw.
 * Waits first for an operation already running (a buffer takes one at a time).
 */
function settleBuffer(buffer: LiveSourceBufferLike, op: () => void): Promise<void> {
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener('error', bad);
        resolve();
      };
      const bad = () => {
        buffer.removeEventListener('updateend', done);
        reject(new Error('SourceBuffer error'));
      };
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', bad, { once: true });
      try {
        op();
      } catch (e) {
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', bad);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  if (!buffer.updating) return run();
  return new Promise<void>((resolve) =>
    buffer.addEventListener('updateend', () => resolve(), { once: true })
  ).then(run);
}
