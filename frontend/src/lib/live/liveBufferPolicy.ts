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
 * - THE ANCHOR SITS ONE POLL ABOVE THAT WAIT ({@link LiveBufferPolicy.targetMs}): a delivery's phase
 *   against the poll moves by up to one poll, so an anchor exactly at the wait would re-anchor on that
 *   ordinary jitter - and never under {@link LIVE_PLAYER_MARGIN_SEGMENTS} segments.
 *
 * AND WHY NOTHING HERE EVER SEEKS BACKWARD (owner, 2026-11-09, production: a broadcaster on a bad link
 * and the viewer "replays the current segment in a loop until the next one arrives"). A short buffer
 * used to be re-anchored at `end - target` - BEHIND the playhead whenever the media ahead was under
 * the target, which is exactly when it was re-anchored - and so was the first delivery after a stall.
 * Every late segment therefore showed the reader the seconds they had just watched again. Margin is
 * media not yet shown, and only two things make it: the join's anchor, and playing slower than the
 * producer ({@link LiveBufferPolicy.pace}). {@link liveSeekPoint} answers forward or not at all.
 *
 * A gap that is an outage, not a cadence (a catch-up jump, a retried poll, a quiet broadcaster) is
 * never recorded: {@link LiveBufferPolicy.interrupt}.
 */

import {
  LIVE_MANIFEST_POLL_MS,
  LIVE_PLAYER_CADENCE_WINDOW,
  LIVE_PLAYER_DRIFT_SLACK_MS,
  LIVE_PLAYER_FAST_RATE,
  LIVE_PLAYER_MARGIN_SEGMENTS,
  LIVE_PLAYER_MIN_TARGET_BUFFER_MS,
  LIVE_PLAYER_SLOW_RATE,
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

/**
 * Where a seek puts the playhead now at `position`, or null for no seek - and NEVER BEFORE
 * `position`: media already shown is never shown again (owner, 2026-11-09). The anchor is
 * `targetMs` behind the newest buffered media, clamped to the start of its range; it is taken only
 * when it lies ahead (a join, a backlog jumped, a viewer drifted past its slack, a hole to cross).
 * Otherwise, a playhead with nothing playable under it (the end of a range, a hole) goes to the
 * first media buffered past it, and one with media ahead stays where it is: it plays on by itself.
 */
export function liveSeekPoint(
  position: number,
  ranges: LiveTimeRanges | null,
  targetMs: number
): number | null {
  if (!ranges || ranges.length === 0) return null;
  const last = ranges.length - 1;
  const anchor = Math.max(ranges.start(last), ranges.end(last) - targetMs / 1000);
  if (anchor > position) return anchor;
  if (mediaAheadS(position, ranges) > 0) return null;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) > position) return ranges.start(i);
  }
  return null;
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
 * Why a delivery re-anchors the playhead at the target, when nothing else asked for a seek: `drift`,
 * the video sits past the target plus {@link LIVE_PLAYER_DRIFT_SLACK_MS} behind the edge - a FORWARD
 * seek. A margin too short is never re-anchored (that seek went backward, and replayed): it is
 * rebuilt by {@link LiveBufferPolicy.pace}.
 */
export type LiveReanchor = 'drift';

/**
 * The pace the video plays at: `steady` 1x; `slow` ({@link LIVE_PLAYER_SLOW_RATE}) while the margin
 * is short, so it grows back; `fast` ({@link LIVE_PLAYER_FAST_RATE}) while the viewer sits past it.
 */
export type LivePace = 'slow' | 'steady' | 'fast';

/** The playback rate of a {@link LivePace}. */
export function livePaceRate(pace: LivePace): number {
  return pace === 'slow' ? LIVE_PLAYER_SLOW_RATE : pace === 'fast' ? LIVE_PLAYER_FAST_RATE : 1;
}

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

  /** The longest segment measured, in ms; {@link LIVE_SEGMENT_MS} before any delivery measured one. */
  get segmentMs(): number {
    const longest = this.groups.reduce((a, g) => Math.max(a, g.segmentMs), 0);
    return longest > 0 ? longest : LIVE_SEGMENT_MS;
  }

  /**
   * How far behind the newest buffered media the player anchors, in ms: the longest wait plus one
   * poll (the jitter of a delivery's phase against the poll, so ordinary jitter never re-anchors),
   * and never under {@link LIVE_PLAYER_MARGIN_SEGMENTS} segments of the length measured - the margin
   * a late segment is absorbed by (owner, 2026-11-09).
   */
  get targetMs(): number {
    return Math.max(this.longestWaitMs + this.pollMs, LIVE_PLAYER_MARGIN_SEGMENTS * this.segmentMs);
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
    return segments * this.segmentMs > this.maxBehindMs;
  }

  /**
   * Whether a delivery that left `aheadMs` of media before the playhead re-anchors it at the
   * target ({@link LiveReanchor}); null when it plays on.
   */
  reanchor(aheadMs: number): LiveReanchor | null {
    return aheadMs > this.maxBehindMs ? 'drift' : null;
  }

  /**
   * The pace to play at, from `aheadMs` of media before the playhead and the pace now. Deterministic
   * thresholds on the buffered range, read at the manifest poll the player makes anyway - no timer.
   *
   * AT A DELIVERY (`atDelivery`) the media ahead is at its peak, which a steady producer holds within
   * one poll under the target (the delivery's phase against the poll). So: under `target - poll`
   * slows, over `target + poll` speeds up, and each comes back to 1x only once the peak has crossed
   * the target itself - a band of a poll on each side, so ordinary jitter never flips the rate.
   * BETWEEN DELIVERIES the media ahead only falls, by design down to `target - longestWait` (the
   * longest wait the deliveries' shape explains); under that the producer is later than its own
   * shape, and the video slows at once rather than at the delivery that may not come. Nothing else
   * changes between deliveries, so the rate changes at most once per delivery and once per lateness.
   */
  pace(aheadMs: number, current: LivePace, atDelivery: boolean): LivePace {
    const target = this.targetMs;
    if (!atDelivery) {
      return current !== 'slow' && aheadMs < target - this.longestWaitMs ? 'slow' : current;
    }
    if (current === 'slow') return aheadMs >= target ? 'steady' : 'slow';
    if (current === 'fast') return aheadMs <= target ? 'steady' : 'fast';
    if (aheadMs < target - this.pollMs) return 'slow';
    if (aheadMs > target + this.pollMs) return 'fast';
    return 'steady';
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
