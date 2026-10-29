/**
 * THE LIVE VIEWER'S BUFFER POLICY: how far behind its newest buffered media the player sits, when it
 * re-anchors there, and what a `waiting` from the `<video>` means. Pure - no timer, no DOM: the caller
 * reads its monotonic clock and its buffer and hands the readings in, so the policy is tested with
 * numbers alone.
 *
 * WHY IT EXISTS (L-F1, read on dev 2026-10-26, docs/wiki/frontend/modules/live.md "The buffer
 * policy"). Two defects made a viewer freeze every ~4 s behind an Android broadcaster:
 *
 * 1. The target was a constant (one segment, 2 s), but the Mi 9T's recorder hands its 2 s fragments
 *    over IN PAIRS every 4 s (seals 4-15 ms apart, on every chunk of the reading). A viewer 2 s behind
 *    a source that delivers every 4 s runs dry for ~2 s per period, whatever the network.
 * 2. The player's own seek fires `waiting` (the engine drops its ready state while it seeks), and
 *    that was read as a stall: `stalled at 7.99` logged in the SAME millisecond as `seek ... at 9.99`
 *    (exactly end - 2 s). The latched stall made the next delivery seek again, whose `waiting` latched
 *    again - a seek at every delivery, for as long as the live lasted.
 *
 * AND WHY IT IS SIZED FROM THE DELIVERY'S SHAPE (LIVE-STALL-1, `1.5.1-alpha.7`, 2026-10-29). The
 * target used to be the longest GAP seen, so it grew only AFTER a longer gap had drained the buffer,
 * and it was applied only at a seek - a viewer sitting closer to the edge than its own target was
 * left there. W4 held 3.99 s after a delivery with its target at 4118 ms, the next gap was 4223 ms,
 * and it stalled. Both are fixed here:
 *
 * - THE LONGEST WAIT IS BOUNDED FROM WHAT A DELIVERY SHOWS, before the gap that would prove it: a
 *   delivery of K segments of D ms each means the producer withheld K x D of media, so its next
 *   handover can come K x D later, and the poll learns of it up to one {@link LIVE_MANIFEST_POLL_MS}
 *   after that. {@link LiveBufferPolicy.longestWaitMs} is the largest of that bound, the longest gap
 *   measured, and the floor.
 * - A BUFFER SHORTER THAN THE LONGEST WAIT IS RE-ANCHORED AT ONCE ({@link LiveBufferPolicy.reanchor}),
 *   not left to stall: after a delivery, the media ahead must outlast the wait for the next one.
 * - THE ANCHOR SITS ONE POLL ABOVE THAT WAIT ({@link LiveBufferPolicy.targetMs}): a delivery's phase
 *   against the poll moves by up to one poll, so an anchor exactly at the wait would re-anchor on that
 *   ordinary jitter - a backward seek every few deliveries.
 *
 * A gap that is an outage, not a cadence (a catch-up jump, a retried poll, a quiet broadcaster) is
 * never recorded: {@link LiveBufferPolicy.interrupt}.
 */

import {
  LIVE_MANIFEST_POLL_MS,
  LIVE_PLAYER_CADENCE_WINDOW,
  LIVE_PLAYER_DRIFT_SLACK_MS,
  LIVE_PLAYER_MIN_TARGET_BUFFER_MS,
  LIVE_SEGMENT_MS,
} from './constants';

/** The `buffered` ranges of a source buffer, as MSE gives them. */
export interface LiveTimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * What a `waiting` of the `<video>` means, decided once from facts the engine holds:
 * - `seeking`: the engine is completing a seek (`video.seeking`) - its own wait, NOT a stall;
 * - `held`: the range holding the playhead has `ahead` seconds of media past it - nothing is missing,
 *   the engine's decoder or renderer fell behind and resumes on its own (LIVE-STALL-1,
 *   `1.5.1-alpha.8`: W4 waited at 55.56 with 58.19 buffered in one range and played on to 55.74
 *   before any seek). Seeking forward would skip media for a wait no seek shortens; whether it DID
 *   resume is read at the next delivery, from the playhead;
 * - `time-gap`: media is buffered past a hole ahead (a camera re-acquired, its timestamps moved
 *   forward) - no engine plays across it, so the player seeks to `to`;
 * - `starved`: nothing playable ahead - the next delivery came later than the buffer lasted.
 */
export type LiveWait =
  | { kind: 'seeking' }
  | { kind: 'held'; ahead: number }
  | { kind: 'time-gap'; to: number }
  | { kind: 'starved' };

/**
 * How much media must lie ahead, in seconds, before a wait is read as something other than a dry
 * buffer: a hole to cross, or the engine's own wait inside a range.
 */
const GAP_AHEAD_S = 0.5;

/**
 * How many seconds can play from `position` before the video waits: the rest of the range holding
 * it, or 0 when it sits in no range (a hole, or before the first media).
 */
export function mediaAheadS(position: number, ranges: LiveTimeRanges | null): number {
  if (!ranges) return 0;
  for (let i = 0; i < ranges.length; i++) {
    if (position >= ranges.start(i) && position < ranges.end(i)) return ranges.end(i) - position;
  }
  return 0;
}

/**
 * The buffered ranges for a log line, two decimals each: `[0.00-4.00 34.00-36.00]`, `[]` with
 * nothing buffered. A hole ahead of the playhead is visible here and nowhere else.
 */
export function formatLiveRanges(ranges: LiveTimeRanges | null): string {
  const spans: string[] = [];
  for (let i = 0; i < (ranges?.length ?? 0); i++) {
    spans.push(`${ranges!.start(i).toFixed(2)}-${ranges!.end(i).toFixed(2)}`);
  }
  return `[${spans.join(' ')}]`;
}

/** Classifies a `waiting` - see {@link LiveWait}. */
export function classifyLiveWait(
  seeking: boolean,
  position: number,
  ranges: LiveTimeRanges | null
): LiveWait {
  if (seeking) return { kind: 'seeking' };
  const ahead = mediaAheadS(position, ranges);
  if (ahead > GAP_AHEAD_S) return { kind: 'held', ahead };
  if (ranges && ranges.length > 0) {
    const last = ranges.length - 1;
    const start = ranges.start(last);
    if (ranges.end(last) > position + GAP_AHEAD_S && start > position) {
      return { kind: 'time-gap', to: start };
    }
  }
  return { kind: 'starved' };
}

/** Why the next delivery's gap must not be read as the producer's cadence. */
export type LiveCadenceBreak =
  /** The viewer jumped to the newest segment: the gap was a backlog, not a cadence. */
  | 'catch-up'
  /** A step failed and is retried: the gap is the viewer's own outage. */
  | 'retry'
  /** The server says the broadcaster stored nothing for a while: its absence, not its cadence. */
  | 'broadcaster-quiet';

/**
 * What one delivery brought: how many segments were appended, and how much media they added at the
 * buffered end, in ms - `null` when that growth does not measure them (a hole opened: a re-acquired
 * camera's timestamps jumped forward, so the end moved by the time away, not by the segments).
 */
export interface LiveDeliveryShape {
  segments: number;
  mediaMs: number | null;
}

/** What one delivery did to the policy. */
export interface LiveDelivery {
  /** The wall-clock gap since the previous delivery, in ms; null when none is to be measured. */
  gapMs: number | null;
  /** The target after this delivery, in ms. */
  targetMs: number;
  /** Whether this delivery raised the target. */
  grew: boolean;
}

/**
 * Why a delivery re-anchors the playhead at the target, when nothing else asked for a seek:
 * - `short`: the media ahead would not outlast {@link LiveBufferPolicy.longestWaitMs} - the next
 *   delivery may come after it runs dry;
 * - `drift`: the video sits past the target plus {@link LIVE_PLAYER_DRIFT_SLACK_MS} behind the edge.
 */
export type LiveReanchor = 'short' | 'drift';

/** One per run of a viewer: reset at every (re)start. */
export class LiveBufferPolicy {
  private readonly gaps: number[] = [];
  /** The measured deliveries' sizes over the same window as the gaps: segments, ms per segment. */
  private readonly groups: { segments: number; segmentMs: number }[] = [];
  private lastDeliveryAt: number | null = null;

  constructor(
    private readonly window: number = LIVE_PLAYER_CADENCE_WINDOW,
    private readonly floorMs: number = LIVE_PLAYER_MIN_TARGET_BUFFER_MS,
    private readonly pollMs: number = LIVE_MANIFEST_POLL_MS
  ) {
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`live buffer policy: window ${window} is not a positive integer`);
    }
  }

  /**
   * The longest the viewer may wait for its next media, in ms: the largest of the floor (one segment
   * plus one poll), the longest gap measured, and the GROUP BOUND - the largest group of segments one
   * delivery brought, times the longest segment measured, plus one poll. The bound is known from the
   * first grouped delivery, before any gap has had to prove it.
   */
  get longestWaitMs(): number {
    const gap = this.gaps.reduce((a, b) => Math.max(a, b), this.floorMs);
    if (this.groups.length === 0) return gap;
    const most = this.groups.reduce((a, g) => Math.max(a, g.segments), 0);
    const longest = this.groups.reduce((a, g) => Math.max(a, g.segmentMs), 0);
    return Math.max(gap, most * longest + this.pollMs);
  }

  /**
   * How far behind the newest buffered media the player anchors, in ms: the longest wait plus one
   * poll, the jitter of a delivery's phase against the poll, so ordinary jitter never re-anchors.
   */
  get targetMs(): number {
    return this.longestWaitMs + this.pollMs;
  }

  /** Past this many ms behind the newest buffered media, the player seeks back to the target. */
  get maxBehindMs(): number {
    return this.targetMs + LIVE_PLAYER_DRIFT_SLACK_MS;
  }

  /**
   * Whether `segments` new segments in one manifest are a BACKLOG to jump over rather than media to
   * play: when appending them all would put the video past {@link maxBehindMs} anyway, so the drift
   * would seek over them after paying their download. Sized by the longest segment measured (the
   * floor's own segment, {@link LIVE_SEGMENT_MS}, before any): a producer's ordinary group - a pair,
   * the flush of its last fragments at the end of the live - is played, never skipped
   * (LIVE-WEB-2, `1.5.1-alpha.7`: three segments at the end were "3 segments behind" and two were
   * dropped).
   */
  isBacklog(segments: number): boolean {
    const longest = this.groups.reduce((a, g) => Math.max(a, g.segmentMs), 0);
    return segments * (longest > 0 ? longest : LIVE_SEGMENT_MS) > this.maxBehindMs;
  }

  /**
   * Whether a delivery that left `aheadMs` of media before the playhead re-anchors it at the
   * target, and why ({@link LiveReanchor}); null when it plays on.
   */
  reanchor(aheadMs: number): LiveReanchor | null {
    if (aheadMs < this.longestWaitMs) return 'short';
    if (aheadMs > this.maxBehindMs) return 'drift';
    return null;
  }

  /**
   * Media was appended at `nowMs` (the caller's monotonic clock), in the shape `shape` says. The
   * first delivery after a reset or an {@link interrupt} only anchors the next measurement - its gap
   * and its size are a backlog (the join, a catch-up), not the producer's cadence.
   */
  delivered(nowMs: number, shape?: LiveDeliveryShape): LiveDelivery {
    const before = this.targetMs;
    const previous = this.lastDeliveryAt;
    this.lastDeliveryAt = nowMs;
    if (previous === null) return { gapMs: null, targetMs: before, grew: false };
    const gap = Math.max(0, nowMs - previous);
    this.gaps.push(gap);
    if (this.gaps.length > this.window) this.gaps.shift();
    if (shape && shape.segments > 0 && shape.mediaMs !== null && shape.mediaMs > 0) {
      this.groups.push({ segments: shape.segments, segmentMs: shape.mediaMs / shape.segments });
      if (this.groups.length > this.window) this.groups.shift();
    }
    const after = this.targetMs;
    return { gapMs: gap, targetMs: after, grew: after > before };
  }

  /** The gap running now is not a cadence ({@link LiveCadenceBreak}): it will not be recorded. */
  interrupt(_why: LiveCadenceBreak): void {
    this.lastDeliveryAt = null;
  }

  /** Forgets every gap and group: a new run measures its own producer. */
  reset(): void {
    this.gaps.length = 0;
    this.groups.length = 0;
    this.lastDeliveryAt = null;
  }
}
