/**
 * THE LIVE VIEWER'S PLAYER: a growing fMP4 source fed through Media Source Extensions, one sealed
 * segment at a time, kept behind the live edge by the buffer policy (`liveBufferPolicy.ts`): one poll
 * past the longest wait for the next delivery, which the shape of the deliveries bounds before a gap
 * proves it (WP-L5, L-F1, LIVE-STALL-1).
 *
 * The sequence is the one the WP-L1 bench measured (0 append errors in ~2 200 segments, Chromium
 * `MediaSource` and iOS WebKit `ManagedMediaSource`; `tools/live-bench/bench.js` on
 * `bench/live-wp-l1`):
 *
 * 1. `GET /api/lives/:id` - the key, and a seat on the host's viewer cap.
 * 2. One `SourceBuffer` of {@link LIVE_RECORDER_MIME}, `mode = 'segments'`.
 * 3. The JOIN on the newest {@link LIVE_PLAYER_JOIN_SEGMENTS} segments. Every segment is
 *    SELF-CONTAINED - the recorder's init (`ftyp` + `moov`) then one fragment (`moof` + `mdat`), the
 *    broadcaster's shape (#2115) - so no hunt for segment 0: their inits, their fragments, then a
 *    seek to the policy's target behind the edge. A later segment's init is
 *    appended only when it DIFFERS from the last one (a camera re-acquired mid-live); its media
 *    timestamps then jump FORWARD, leaving a time gap that a `waiting` seeks across at once.
 * 4. A manifest poll every {@link LIVE_MANIFEST_POLL_MS} from the last index taken; each new
 *    segment fetched (the plain public fetch), opened with the live key, appended in order. A backlog
 *    longer than the policy lets the video sit behind (`LiveBufferPolicy.isBacklog`), or a gap the
 *    window already passed, or a stall, and the player jumps to the newest and seeks to the edge
 *    rather than replaying the backlog. A delivery that leaves less media ahead than the longest wait
 *    for the next one re-anchors at the target at once (`LiveBufferPolicy.reanchor`).
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
import { Fmp4ParseError, initSegmentEnd } from './fmp4Segments';
import { liveViewerCount } from './liveViewerCount';
import {
  classifyLiveWait,
  formatLiveRanges,
  LiveBufferPolicy,
  mediaAheadS,
  type LiveCadenceBreak,
  type LiveTimeRanges,
} from './liveBufferPolicy';
import {
  LIVE_BROADCASTER_QUIET_MS,
  LIVE_MANIFEST_POLL_MS,
  LIVE_PLAYER_JOIN_SEGMENTS,
  LIVE_PLAYER_KEEP_BEHIND_MS,
  LIVE_RECORDER_MIME,
} from './constants';
import {
  isTerminalLiveState,
  liveFailureOutcome,
  liveRetryDelayMs,
  type LiveViewerState,
} from './liveViewerState';
import type { LiveChatBlock, LiveChatQuery, LiveManifest, LiveManifestSegment } from './types';

export type { LiveTimeRanges } from './liveBufferPolicy';

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
  /** True while the engine completes a seek: a `waiting` then is the seek's own, never a stall. */
  readonly seeking: boolean;
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
  /**
   * A monotonic clock in ms (`performance.now`). Read, never waited on: the buffer policy measures
   * the gap between two deliveries with it, and no decision is ever deferred by it.
   */
  now(): number;
}

/**
 * What the player asks of a chat riding its poll (`LiveChatSession` implements it). `onKey` hands it
 * the live key the open fetched; `query` and `receive` frame each manifest request.
 */
export interface LivePlayerChatHook {
  onKey(keyHex: string): void;
  query(): LiveChatQuery;
  receive(block: LiveChatBlock | undefined): void;
}

/** Options of a {@link LivePlayer}. */
export interface LivePlayerOptions {
  liveId: string;
  video: LiveVideoLike;
  /** Told every state change. */
  onState(state: LiveViewerState): void;
  /** Told the live's age at each manifest (the database's clock on both ends), in ms. */
  onElapsed?(ms: number): void;
  /**
   * Told the manifest's viewer count at each poll, and `null` on every failed step (none to show:
   * a number on screen is always the last answered poll's). A number, never a name.
   */
  onViewers?(count: number | null): void;
  /**
   * The live chat (WP-L6), riding THIS poll: asked for its cursors before each manifest request and
   * handed the answer's `chat` block - one request a tick, no second timer. Absent: no chat asked.
   */
  chat?: LivePlayerChatHook;
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
  now: () => performance.now(),
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
  /**
   * Cancels the run's segment downloads. A closed or restarted viewer must not leave a fetch
   * running beside the new run's: nginx bounds segment connections per address (`limit_conn`).
   */
  private downloads: AbortController | null = null;
  private detach: (() => void) | null = null;

  private keyHex: string | null = null;
  private startedAtMs = 0;
  private seated = false;
  private source: LiveMediaSourceLike | null = null;
  private buffer: LiveSourceBufferLike | null = null;
  /** The last init appended (`ftyp` + `moov`), or null before the first. */
  private lastInit: Uint8Array | null = null;
  private joined = false;
  /** The highest index taken (appended or skipped); -1 before the join. */
  private last = -1;
  private retryAttempt = 0;
  /** Segments in a row that did not open, and appends in a row that failed: two counters, so one
   * success of the other kind never hides a run of failures. */
  private openFailures = 0;
  private appendFailures = 0;
  /** True from `start()` until `stop()` or a final state: a stale continuation must not act then. */
  private running = false;
  private stalled = false;
  /**
   * Where the playhead stood at the engine's own wait (`held`, media buffered ahead of it), until
   * the next delivery reads whether it moved since; null when no such wait is open.
   */
  private heldAt: number | null = null;
  private broadcasterQuiet = false;
  /** How far behind the edge to sit, from the delivery cadence this run measures. */
  private readonly policy = new LiveBufferPolicy();
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
    this.downloads = new AbortController();
    this.resetRun();
    this.running = true;
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
    this.running = false;
    this.summarise('stopped');
    this.teardownMedia();
    this.giveBackSeat();
  }

  /**
   * A refusal heard OUTSIDE the player's own requests - the chat's write (WP-L6) - that the live is
   * over for this viewer. It goes through the SAME decision as the player's own failures
   * ({@link liveFailureOutcome} via `fail`), so the screen is the one the next poll would have shown,
   * its `endReason` included. A verdict that would only be a retry is not the chat's to act on.
   */
  refusedElsewhere(error: unknown): void {
    if (!this.running) return;
    const outcome = liveFailureOutcome(error, this.joined || this.keyHex !== null);
    if (outcome === 'retry') {
      console.debug(`[LIVE] viewer ${this.liveId}: a chat refusal that is no verdict - ignored`);
      return;
    }
    console.debug(`[LIVE] viewer ${this.liveId}: the chat heard the live is over`);
    this.fail(this.generation, error, async () => {});
  }

  /**
   * The `<video>` fired `waiting`. Classified ONCE ({@link classifyLiveWait}): the wait of a seek is
   * no stall and changes nothing; the engine's own wait with media ahead is left to end by itself
   * and read again at the next delivery; a hole ahead is crossed now; a starved buffer makes the
   * next delivery re-anchor at the policy's target - which that delivery's own gap has already raised.
   */
  noteStall(): void {
    if (!this.joined || this.stalled) return;
    const at = this.video.currentTime;
    const ranges = this.buffer?.buffered ?? null;
    const wait = classifyLiveWait(this.video.seeking, at, ranges);
    switch (wait.kind) {
      case 'seeking':
        console.debug(
          `[LIVE] viewer ${this.liveId}: waiting while seeking at ${at.toFixed(2)} - not a stall`
        );
        return;
      case 'held':
        // Nothing is missing ahead (LIVE-STALL-1, `1.5.1-alpha.8`): a seek would skip media and
        // shorten nothing. The next delivery reads the playhead: moved, the wait ended by itself;
        // still here, it is a stall and is re-anchored as one.
        console.debug(
          `[LIVE] viewer ${this.liveId}: waiting at ${at.toFixed(2)} with ${wait.ahead.toFixed(2)} s buffered ahead ${formatLiveRanges(ranges)} - the engine's own wait`
        );
        this.heldAt = at;
        return;
      case 'time-gap':
        // The broadcaster re-acquired its camera, its timestamps moved forward: no engine plays
        // across the hole, so seek now - once.
        this.seekToEdge('time gap');
        return;
      case 'starved':
        this.latchStall(at);
        return;
    }
  }

  /**
   * The `<video>` reported an `error` (a decode error after a bad append, a source that could not
   * open): nothing more will play from this source, so the live is called unplayable at once rather
   * than fed segments it can no longer take.
   */
  noteMediaError(): void {
    if (!this.running) return;
    console.error(`[LIVE] viewer ${this.liveId}: the video reported an error`);
    this.fail(
      this.generation,
      new StopOn({ kind: 'unavailable', reason: 'playback' }),
      async () => {}
    );
  }

  // ------------------------------------------------------------------------------------------

  /**
   * The manifest, with the chat's cursors when a chat rides the poll. The catch-up's second fetch
   * (the newest window) asks no chat: one chat block a tick, so a cursor is never answered twice.
   */
  private manifestWithChat(from?: number): Promise<LiveManifest> {
    const chat = this.opts.chat;
    if (!chat) {
      return from === undefined
        ? this.deps.fetchManifest(this.liveId)
        : this.deps.fetchManifest(this.liveId, from);
    }
    return this.deps.fetchManifest(this.liveId, from, chat.query());
  }

  private resetRun(): void {
    this.keyHex = null;
    this.lastInit = null;
    this.joined = false;
    this.last = -1;
    this.retryAttempt = 0;
    this.openFailures = 0;
    this.appendFailures = 0;
    this.stalled = false;
    this.heldAt = null;
    this.broadcasterQuiet = false;
    this.policy.reset();
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
    this.abortDownloads();
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.detach?.();
    this.detach = null;
    this.source = null;
    this.buffer = null;
  }

  /** Cancels every segment download of the run that is ending; its rejection is then ignored. */
  private abortDownloads(): void {
    if (!this.downloads) return;
    console.debug(`[LIVE] viewer ${this.liveId}: segment downloads of the ending run cancelled`);
    this.downloads.abort();
    this.downloads = null;
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
    // No stale count: until a poll answers again, the last number is no longer known to be true.
    this.opts.onViewers?.(null);
    const outcome =
      error instanceof StopOn
        ? { stop: error.state }
        : // Once the key was served, the live existed for this viewer: a 404 is its end.
          liveFailureOutcome(error, this.joined || this.keyHex !== null);
    if (outcome === 'retry') {
      this.interruptCadence('retry');
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
    this.running = false;
    this.summarise(final.kind);
    this.abortDownloads();
    this.cancelTimer?.();
    this.cancelTimer = null;
    // A refused seat (`full`) was never held. Every other final state gives it back - an ended live
    // included: the server's purge of an ordinary end waits for its seated viewers, so this is what
    // tells it this viewer is owed nothing more (lives.md, "Deletion: at the end, plus a sweep").
    if (final.kind === 'full') this.seated = false;
    else this.giveBackSeat();
    // Every final screen stops the picture and its sound: nothing plays behind it.
    this.video.pause();
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
        if (!this.alive(gen)) {
          // Closed while the key was on its way: the seat it took goes straight back - unless a
          // newer run is open, which holds the SAME seat (a seat is per account) and keeps it.
          if (!this.running) {
            this.seated = true;
            this.giveBackSeat();
          }
          return;
        }
        this.seated = true;
        this.keyHex = live.key;
        this.opts.chat?.onKey(live.key);
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
    const manifest = await this.manifestWithChat();
    if (!this.alive(gen)) return;
    this.retryAttempt = 0;
    this.readClock(manifest);
    this.opts.chat?.receive(manifest.chat);
    const newest = manifest.segments.at(-1);
    if (!newest) {
      // On air, no segment stored yet: ask again at the poll's pace.
      console.debug(`[LIVE] viewer ${this.liveId}: no segment yet, waiting`);
      this.later(gen, LIVE_MANIFEST_POLL_MS, (g) => this.open(g));
      return;
    }
    // Every segment is self-contained (its init, then one fragment - the broadcaster's shape), so
    // any one can start the picture. The newest LIVE_PLAYER_JOIN_SEGMENTS are taken, so the first
    // frame has the policy's smallest target ahead of it; the newest one cannot be skipped.
    for (const s of manifest.segments.slice(-LIVE_PLAYER_JOIN_SEGMENTS)) {
      if (s.index > this.last) await this.take(gen, s, s === newest);
      if (!this.alive(gen)) return;
    }
    this.joined = true;
    this.policy.delivered(this.deps.now());
    this.seekToEdge('join');
    this.resume();
    console.log(`[LIVE] viewer joined ${this.liveId} at segment ${newest.index}`);
    this.showPlaying();
    this.later(gen, LIVE_MANIFEST_POLL_MS, (g) => this.poll(g));
  }

  /** Step 4: one manifest poll and what it brought. */
  private async poll(gen: number): Promise<void> {
    try {
      const manifest = await this.manifestWithChat(this.last + 1);
      if (!this.alive(gen)) return;
      this.retryAttempt = 0;
      this.readClock(manifest);
      this.opts.chat?.receive(manifest.chat);
      let fresh = manifest.segments.filter((s) => s.index > this.last);
      // The jump this poll owes for its OWN reason (a catch-up). A stall is NOT read here: it is
      // read after the appends below, because `waiting` may latch while the segments are awaited.
      let catchUp = false;
      // How far behind the broadcaster this viewer is, from the server's own count. `?from=` answers
      // the OLDEST window from that index, so after a background the window is still the past: the
      // viewer asks for the NEWEST window instead and takes only its newest segment.
      const behind = manifest.nextIndex - 1 - this.last;
      if (this.policy.isBacklog(behind)) {
        const top =
          manifest.segments.at(-1)?.index === manifest.nextIndex - 1
            ? manifest
            : await this.deps.fetchManifest(this.liveId);
        if (!this.alive(gen)) return;
        const newest = top.segments.at(-1);
        fresh = newest && newest.index > this.last ? [newest] : [];
        if (newest) {
          console.debug(
            `[LIVE] viewer ${this.liveId}: ${behind} segments behind - jumping from ${this.last} to ${newest.index}`
          );
          this.skipped += Math.max(0, newest.index - this.last - 1);
        }
        this.interruptCadence('catch-up');
        catchUp = true;
      }
      if (fresh.length > 0) {
        const before = this.appended;
        const seen = this.playhead();
        for (const s of fresh) {
          await this.take(gen, s);
          if (!this.alive(gen)) return;
        }
        if (this.appended > before) this.noteDelivery(fresh, this.appended - before, seen);
        // THE STALL LATCH IS READ HERE, AFTER EVERY AWAIT OF THIS DELIVERY, AND CLEARED ONLY BY THE
        // RE-ANCHOR IT ASKED FOR. A `waiting` that latched while the segments were fetched, opened
        // or appended is therefore re-anchored now, on the media that just arrived - never cleared
        // with no seek (LIVE-STALL-1: a stall latched mid-fetch was wiped, and the viewer stalled
        // again 4 s later). A stall latched during the trim below stays latched for the next one.
        // Otherwise the policy says whether the media ahead outlasts the longest wait for the next
        // delivery (`short`: re-anchored NOW, before that wait drains it - LIVE-STALL-1) or sits
        // past the target and its slack (`drift`). The engine's own wait, if one is open, is read
        // first: a playhead that never moved since is a stall like any other.
        this.settleHeldWait();
        const stall = this.stalled;
        const why = stall ? 'stall' : catchUp ? 'catch-up' : this.policy.reanchor(this.behindMs());
        if (why !== null && this.seekToEdge(why) && stall) this.stalled = false;
        // A pause from outside (an audio interruption, another player claiming playback) is not
        // left frozen until the drift forces a seek.
        this.resume();
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
      sealed = await this.deps.fetchSegment(this.liveId, s.name, this.downloads?.signal);
    } catch (e) {
      if (!isLiveRefusal(e, 'not-found') || required) throw e;
      console.warn(`[LIVE] viewer ${this.liveId}: segment ${s.index} is gone - skipped`);
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
        `[LIVE] viewer ${this.liveId}: segment ${s.index} did not open (${this.openFailures} in a row)`
      );
      if (required || this.openFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
        throw new StopOn({ kind: 'unavailable', reason: 'undecryptable' });
      }
      this.skipped++;
      return null;
    }
  }

  /**
   * Takes one segment: open it, append its init when it differs from the last one appended (a
   * camera re-acquired mid-live writes a NEW init; an identical one is skipped as a no-op), then its
   * fragment. A first segment with no init cannot be played and stops the viewer.
   */
  private async take(gen: number, s: LiveManifestSegment, required = false): Promise<void> {
    const media = await this.openOne(gen, s, required);
    if (!this.alive(gen)) return;
    this.last = Math.max(this.last, s.index);
    if (!media) return;
    let end: number;
    try {
      end = initSegmentEnd(media);
    } catch (e) {
      if (!(e instanceof Fmp4ParseError)) throw e;
      // The seal opened, so these bytes are the broadcaster's own: its recorder wrote a box no
      // engine can frame, and every later segment of that recorder will be the same.
      console.error(
        `[LIVE] viewer ${this.liveId}: segment ${s.index} is not framable (${e.message})`
      );
      throw new StopOn({ kind: 'unavailable', reason: 'playback' });
    }
    if (end > 0) {
      const init = media.subarray(0, end);
      if (!this.lastInit || !sameBytes(init, this.lastInit)) {
        if (this.lastInit)
          console.debug(`[LIVE] viewer ${this.liveId}: a new init at segment ${s.index}`);
        await this.append(gen, init);
        this.lastInit = init.slice();
      }
    } else if (!this.lastInit) {
      console.warn(`[LIVE] viewer ${this.liveId}: segment ${s.index} carries no init to start on`);
      throw new StopOn({ kind: 'unavailable', reason: 'playback' });
    }
    const body = media.subarray(end);
    if (body.byteLength > 0) await this.append(gen, body);
    this.appended++;
    if (this.appended % SUMMARY_EVERY === 0) this.summarise('playing');
  }

  /**
   * Appends bytes and waits for the buffer to settle. A failure counts towards "unplayable"; only a
   * successful APPEND resets that count. A run closed meanwhile (its source detached) returns
   * quietly: an ordinary close is not an append error.
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
        `[LIVE] viewer ${this.liveId}: append failed (${this.appendFailures} in a row)`,
        e
      );
      if (this.lastInit === null || this.appendFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
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

  /**
   * Reads the engine's own wait ({@link heldAt}) at a delivery and closes it: a playhead that moved
   * since ended it by itself (said, nothing to do); one still where it waited is a stall the engine
   * did not recover from, latched for this delivery's re-anchor. The proof is the playhead, read at
   * a delivery the poll was making anyway - no timer.
   */
  private settleHeldWait(): void {
    const heldAt = this.heldAt;
    if (heldAt === null) return;
    this.heldAt = null;
    const at = this.video.currentTime;
    if (at !== heldAt) {
      console.debug(
        `[LIVE] viewer ${this.liveId}: the engine's own wait at ${heldAt.toFixed(2)} ended by itself, now at ${at.toFixed(2)}`
      );
      return;
    }
    this.latchStall(at);
  }

  /** A stall at `at`: said once, and latched for the next delivery's re-anchor. */
  private latchStall(at: number): void {
    console.debug(
      `[LIVE] viewer ${this.liveId} stalled at ${at.toFixed(2)} (target ${Math.round(this.policy.targetMs)} ms)`
    );
    this.stalled = true;
  }

  /** How far behind its buffered end the video plays, in ms. */
  private behindMs(): number {
    const ranges = this.buffer?.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return (ranges.end(ranges.length - 1) - this.video.currentTime) * 1000;
  }

  /**
   * Puts the video the policy's target behind the newest buffered media, and plays. Returns whether
   * it seeked: with nothing buffered there is no edge, and a stall latched stays latched.
   */
  private seekToEdge(why: string): boolean {
    const ranges = this.buffer?.buffered;
    if (!ranges || ranges.length === 0) {
      console.debug(`[LIVE] viewer ${this.liveId}: no media buffered - no seek (${why})`);
      return false;
    }
    const end = ranges.end(ranges.length - 1);
    const start = ranges.start(ranges.length - 1);
    const target = this.policy.targetMs;
    if (why === 'short' && end - target / 1000 < start) {
      // The buffer does not hold the target's worth behind its edge: a seek clamped to its start
      // would replay that start at every delivery until it did. The next deliveries fill it.
      console.debug(
        `[LIVE] viewer ${this.liveId}: ${(end - start).toFixed(2)} s buffered, under the ${Math.round(target)} ms target - no seek (short)`
      );
      return false;
    }
    this.video.currentTime = Math.max(start, end - target / 1000);
    // A seek ends any wait of the engine's own: the playhead it moved proves nothing about it.
    this.heldAt = null;
    this.seeks++;
    console.debug(
      `[LIVE] viewer ${this.liveId}: seek to the live edge (${why}) at ${end.toFixed(2)}, ${Math.round(target)} ms behind`
    );
    this.resume();
    return true;
  }

  /** Where the video plays and what it holds, read at one instant (for the delivery line). */
  private playhead(): LivePlayhead {
    const ranges = this.buffer?.buffered ?? null;
    const at = this.video.currentTime;
    const end = ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : null;
    return {
      at,
      end,
      ahead: mediaAheadS(at, ranges),
      ranges: ranges?.length ?? 0,
      spans: formatLiveRanges(ranges),
    };
  }

  /**
   * Media was appended by a poll: its gap since the previous one feeds the buffer policy, and ONE
   * debug line says what this delivery did to the buffer - the segments, the buffered end, the
   * playhead and the media ahead of it, and every buffered range (a hole ahead of the playhead shows
   * there and nowhere else - LIVE-STALL-1), before and after the append. One delivery per poll at most,
   * so the line is bounded by the poll's own pace, like the seek line beside it. It is what separates
   * a producer whose segments carry uneven media (the end grows by other than one segment's length)
   * from a player that drifts (the playhead moves by other than the wall time between deliveries).
   */
  private noteDelivery(fresh: LiveManifestSegment[], count: number, seen: LivePlayhead): void {
    const now = this.playhead();
    // The media this delivery added, read from the growth of the buffered end - only when no hole
    // opened (a re-acquired camera moves the end by its time away, which measures no segment).
    const mediaMs =
      seen.end !== null && now.end !== null && seen.ranges === now.ranges
        ? (now.end - seen.end) * 1000
        : null;
    const d = this.policy.delivered(this.deps.now(), { segments: count, mediaMs });
    const range = `${fresh[0].index}-${fresh[fresh.length - 1].index}`;
    console.debug(
      `[LIVE] viewer ${this.liveId}: delivery of ${count} appended of ${fresh.length} taken (${range}), gap ${d.gapMs === null ? '-' : Math.round(d.gapMs)} ms: ` +
        `end ${fmtS(seen.end)} -> ${fmtS(now.end)}, at ${fmtS(seen.at)} -> ${fmtS(now.at)}, ` +
        `ahead ${fmtS(seen.ahead)} -> ${fmtS(now.ahead)} s, ` +
        `ranges ${seen.spans} -> ${now.spans}`
    );
    if (d.grew) {
      console.debug(
        `[LIVE] viewer ${this.liveId}: a delivery gap of ${Math.round(d.gapMs ?? 0)} ms - target buffer now ${Math.round(d.targetMs)} ms`
      );
    }
  }

  /** The gap running now is an outage, not the producer's cadence: it is not measured. */
  private interruptCadence(why: LiveCadenceBreak): void {
    console.debug(`[LIVE] viewer ${this.liveId}: delivery gap not measured (${why})`);
    this.policy.interrupt(why);
  }

  private resume(): void {
    if (!this.video.paused) return;
    this.video.play().catch((e: unknown) => {
      // An autoplay refusal (sound without a gesture): the screen's own controls start it.
      console.warn(`[LIVE] viewer ${this.liveId}: play() refused (${String(e)})`);
    });
  }

  /**
   * The manifest's two database times - the live's age, and whether the broadcaster went quiet -
   * and its viewer count, read at the same two places every manifest is.
   */
  private readClock(manifest: LiveManifest): void {
    this.opts.onViewers?.(liveViewerCount(manifest));
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
      if (quiet) this.interruptCadence('broadcaster-quiet');
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

/** The playhead and the buffer at one instant, in seconds; `end` is null with nothing buffered. */
interface LivePlayhead {
  at: number;
  end: number | null;
  ahead: number;
  /** How many buffered ranges there are: a new one means a hole opened. */
  ranges: number;
  /** Every buffered range, for the log line ({@link formatLiveRanges}). */
  spans: string;
}

/** Seconds for a log line, two decimals; `-` for none. */
function fmtS(s: number | null): string {
  return s === null ? '-' : s.toFixed(2);
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

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
